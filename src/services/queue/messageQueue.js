import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { ENV } from '../../config/env.js';
import { defaultWhatsAppProvider } from '../whatsapp/WhatsAppProvider.js';
import { query, withTransaction } from '../../db/index.js';
import { ACK_STATUS } from '../../config/constants.js';

let redisClient = null;
let messageQueue = null;
let messageWorker = null;
let isRedisAvailable = false;

export async function initMessageQueue(io) {
  try {
    redisClient = new IORedis(ENV.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectTimeout: 2000,
      lazyConnect: true
    });

    await redisClient.connect();
    isRedisAvailable = true;
    console.log('✅ Connected to Redis for BullMQ messaging queues');

    messageQueue = new Queue('whatsapp-outgoing-messages', {
      connection: redisClient,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false
      }
    });

    messageWorker = new Worker('whatsapp-outgoing-messages', async (job) => {
      const { tenantId, sessionName, conversationId, messageId, to, text } = job.data;
      
      const sendResult = await defaultWhatsAppProvider.sendTextMessage(
        tenantId,
        sessionName,
        to,
        text
      );

      // Update message with providerMessageId in DB
      await query(`
        UPDATE messages
        SET provider_message_id = $1, ack = $2, status = 'sent'
        WHERE id = $3 AND tenant_id = $4
      `, [sendResult.providerMessageId, ACK_STATUS.SERVER, messageId, tenantId]);

      // Emit real-time confirmation to tenant room
      if (io) {
        io.to(`tenant:${tenantId}`).emit('message:updated', {
          messageId,
          providerMessageId: sendResult.providerMessageId,
          status: 'sent',
          ack: ACK_STATUS.SERVER
        });
      }

      return sendResult;
    }, {
      connection: redisClient,
      concurrency: 5
    });

    messageWorker.on('failed', async (job, err) => {
      console.error(`Message job ${job?.id} failed:`, err.message);
      if (job?.data) {
        await query(`
          UPDATE messages SET status = 'failed', ack = $1
          WHERE id = $2 AND tenant_id = $3
        `, [ACK_STATUS.ERROR, job.data.messageId, job.data.tenantId]);
      }
    });

  } catch (err) {
    console.warn(`ℹ️ Redis unavailable (${err.message}). Using direct transactional delivery.`);
    isRedisAvailable = false;
  }
}

export async function enqueueOutgoingMessage({ tenantId, sessionName, conversationId, messageId, to, text, io }) {
  if (isRedisAvailable && messageQueue) {
    await messageQueue.add('send-text', {
      tenantId,
      sessionName,
      conversationId,
      messageId,
      to,
      text
    });
    return { queued: true };
  }

  // Direct transactional execution fallback
  try {
    const sendResult = await defaultWhatsAppProvider.sendTextMessage(
      tenantId,
      sessionName,
      to,
      text
    );

    await query(`
      UPDATE messages
      SET provider_message_id = $1, ack = $2, status = 'sent'
      WHERE id = $3 AND tenant_id = $4
    `, [sendResult.providerMessageId, ACK_STATUS.SERVER, messageId, tenantId]);

    if (io) {
      io.to(`tenant:${tenantId}`).emit('message:updated', {
        messageId,
        providerMessageId: sendResult.providerMessageId,
        status: 'sent',
        ack: ACK_STATUS.SERVER
      });
    }

    return { queued: false, sendResult };
  } catch (err) {
    await query(`
      UPDATE messages SET status = 'failed', ack = $1
      WHERE id = $2 AND tenant_id = $3
    `, [ACK_STATUS.ERROR, messageId, tenantId]);
    throw err;
  }
}

export async function closeQueue() {
  if (messageWorker) await messageWorker.close();
  if (messageQueue) await messageQueue.close();
  if (redisClient) await redisClient.quit();
}
