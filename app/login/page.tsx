import { redirect } from "next/navigation";
import { AuthLayout } from "@/components/yara/AuthLayout";
import { AuthForm } from "@/components/yara/Forms";
import { currentUser } from "@/lib/server/auth";

export const metadata = { title: "ورود" };

export default async function LoginPage() {
  if (await currentUser()) redirect("/app");
  return (
    <AuthLayout title="ورود به یارا" lead="خوش برگشتید. گفت‌وگوهای قبلی‌تان منتظرند.">
      <AuthForm mode="login" />
    </AuthLayout>
  );
}
