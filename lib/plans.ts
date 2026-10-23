// App plans and feature bundles, read from /v1/me the way `liara app:create` does
// (plans.projects filtered to available g2/free plans in Iran; plans.projectBundlePlans[planID]).
import type { LiaraClient } from "./liara";

type RawPlan = { available?: boolean; region?: string; price?: number; RAM?: { amount?: number }; CPU?: { amount?: number }; volume?: number; storageClass?: string };
type RawBundle = { available?: boolean; displayPrice?: number; buildTimeout?: number; maxDeploymentCountInDay?: number; backupRetention?: number; maxLogsRetention?: number; maxDomainsCount?: number };

export type AppPlan = { id: string; cpu: number; ramGB: number; diskGB: number; monthlyToman: number };
export type Bundle = { id: string; monthlyToman: number; buildTimeoutMin?: number; deploysPerDay?: number; backupRetentionDays?: number; logsRetentionDays?: number; maxDomains?: number };

export async function appPlanOptions(c: LiaraClient) {
  const { plans } = await c.get<{ plans: { projects?: Record<string, RawPlan>; projectBundlePlans?: Record<string, Record<string, RawBundle>> } }>("/v1/me");
  const appPlans: AppPlan[] = Object.entries(plans.projects ?? {})
    .filter(([id, p]) => (id === "free" || id.includes("g2")) && p.available && p.region === "iran")
    .map(([id, p]) => ({ id, cpu: p.CPU?.amount ?? 0, ramGB: p.RAM?.amount ?? 0, diskGB: p.volume ?? 0, monthlyToman: Math.round((p.price ?? 0) * 720) }))
    .sort((a, b) => a.monthlyToman - b.monthlyToman);
  const bundles = (planID: string): Bundle[] =>
    Object.entries(plans.projectBundlePlans?.[planID] ?? {})
      .filter(([, b]) => b.available)
      .map(([id, b]) => ({
        id,
        monthlyToman: b.displayPrice ?? 0,
        buildTimeoutMin: b.buildTimeout,
        deploysPerDay: b.maxDeploymentCountInDay,
        backupRetentionDays: b.backupRetention,
        logsRetentionDays: b.maxLogsRetention,
        maxDomains: b.maxDomainsCount,
      }))
      .sort((a, b) => a.monthlyToman - b.monthlyToman);
  return { appPlans, bundles };
}

// Rough memory floor per platform for a small production app; the model can go higher with reasons.
const MIN_RAM_GB: Record<string, number> = { static: 0.5, react: 0.5, vue: 0.5, angular: 0.5, php: 0.5, go: 0.5, node: 1, next: 1, python: 1, flask: 1, django: 1, laravel: 1, docker: 1, dotnet: 2 };

export async function recommendAppPlan(c: LiaraClient, platform: string, minRamGB?: number) {
  const { appPlans, bundles } = await appPlanOptions(c);
  if (!appPlans.length) throw new Error("No app plans are available for this account (check the balance or team permissions).");
  const need = Math.max(minRamGB ?? 0, MIN_RAM_GB[platform] ?? 1);
  const plan = appPlans.find((p) => p.ramGB >= need && p.id !== "free") ?? appPlans[appPlans.length - 1];
  const options = bundles(plan.id);
  const bundle = options[0];
  return {
    recommended: {
      planID: plan.id,
      bundlePlanID: bundle?.id,
      monthlyToman: plan.monthlyToman + (bundle?.monthlyToman ?? 0),
      why: `${platform} apps need about ${need} GB RAM to run comfortably; ${plan.id} is the cheapest plan with ${plan.ramGB} GB RAM and ${plan.cpu} CPU. "${bundle?.id}" is the cheapest feature bundle for it; pick a higher bundle for longer build timeouts, more daily deploys or longer backups.`,
    },
    plans: appPlans,
    bundlesForRecommended: options,
  };
}
