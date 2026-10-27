import { pumpCampaigns } from "./campaignService.js";
import { pumpAutomations } from "./automationService.js";
import { pumpWebhooks } from "./webhookService.js";
import { pumpLeadReminders } from "./leadService.js";
import { pumpSubscriptions } from "./subscriptionService.js";
import { pumpBilling } from "./billingService.js";
import { pumpReports } from "./reportService.js";
import { pumpNumberHealth } from "./numberHealth.js";
import { pumpRealEstate } from "../solutions/real-estate/leaks.js";
let timer, running;
export function startDomainJobs(io) {
  timer = setInterval(() => {
    if (running) return;
    running = Promise.allSettled([
      pumpAutomations(io),
      pumpCampaigns(io),
      pumpWebhooks(),
      pumpLeadReminders(io),
      pumpSubscriptions(io),
      pumpBilling(io),
      pumpReports(io),
      pumpNumberHealth(io),
      pumpRealEstate(io),
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
