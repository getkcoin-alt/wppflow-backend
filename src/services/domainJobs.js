import { pumpCampaigns } from "./campaignService.js";
import { pumpAutomations } from "./automationService.js";
import { pumpWebhooks } from "./webhookService.js";
import { pumpLeadReminders } from "./leadService.js";
import { pumpSubscriptions } from "./subscriptionService.js";
import { pumpBilling } from "./billingService.js";
import { pumpReports } from "./reportService.js";
import { pumpNumberHealth } from "./numberHealth.js";
import { pumpRealEstate } from "../solutions/real-estate/leaks.js";
import { pumpAiPrep } from "./aiPrepService.js";
import { pumpAutopilot } from "./autopilotService.js";
import { pumpAiBrief } from "./aiBriefService.js";
import { pumpKnowledge } from "./knowledgeService.js";
import { pumpOtp } from "./otp/otpService.js";
import { pumpAgents } from "./agents/activity.js";
import { timeJob } from "./vitals.js";
let timer, running;
// every job is timed (services/vitals.js): the slowest lately is on /health, and one over SLOW_JOB_MS is logged
export function startDomainJobs(io) {
  timer = setInterval(() => {
    if (running) return;
    running = Promise.allSettled([
      timeJob("automations", () => pumpAutomations(io)),
      timeJob("campaigns", () => pumpCampaigns(io)),
      timeJob("webhooks", () => pumpWebhooks()),
      timeJob("lead reminders", () => pumpLeadReminders(io)),
      timeJob("subscriptions", () => pumpSubscriptions(io)),
      timeJob("billing", () => pumpBilling(io)),
      timeJob("reports", () => pumpReports(io)),
      timeJob("number health", () => pumpNumberHealth(io)),
      timeJob("real estate", () => pumpRealEstate(io)),
      timeJob("ai prep", () => pumpAiPrep(io)),
      timeJob("autopilot", () => pumpAutopilot(io)),
      timeJob("ai brief", () => pumpAiBrief(io)),
      timeJob("knowledge", () => pumpKnowledge()),
      timeJob("otp", () => pumpOtp()),
      timeJob("agents", () => pumpAgents()),
    ])
      .then((results) => {
        for (const r of results)
          if (r.status === "rejected")
            console.error("Background job:", r.reason.message);
      })
      .finally(() => {
        running = null;
      });
  }, 4000);
  timer.unref();
}
export async function stopDomainJobs() {
  clearInterval(timer);
  await running;
}
