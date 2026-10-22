import { AuthLayout } from "@/components/yara/AuthLayout";
import { ConnectForm } from "@/components/yara/Forms";
import { requireUser } from "@/lib/server/auth";

export const metadata = { title: "اتصال به لیارا" };

export default async function OnboardingPage() {
  const user = await requireUser();
  return (
    <AuthLayout
      wide
      title="حساب لیارا را وصل کنید"
      lead={`${user.name} عزیز، یارا برای خواندن وضعیت برنامه‌هایتان به یک کلید API لیارا نیاز دارد. با همین کلید فقط تغییرهایی اجرا می‌شود که خودتان تأیید کنید.`}
    >
      <ConnectForm initialTeam={user.teamID ?? ""} />
    </AuthLayout>
  );
}
