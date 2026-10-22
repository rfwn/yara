import { SettingsForm } from "@/components/yara/Forms";
import { DEFAULT_MODEL, MODELS } from "@/lib/models";
import { requireUser } from "@/lib/server/auth";

export const metadata = { title: "تنظیمات" };

export default async function SettingsPage() {
  const user = await requireUser();
  return (
    <div className="settings">
      <h1>تنظیمات</h1>
      <SettingsForm
        user={{ name: user.name, email: user.email, teamID: user.teamID, model: user.model, hasToken: user.hasToken }}
        models={MODELS}
        defaultModel={DEFAULT_MODEL}
      />
    </div>
  );
}
