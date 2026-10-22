import { redirect } from "next/navigation";
import { AuthLayout } from "@/components/yara/AuthLayout";
import { AuthForm } from "@/components/yara/Forms";
import { currentUser } from "@/lib/server/auth";

export const metadata = { title: "ساخت حساب" };

export default async function SignupPage() {
  if (await currentUser()) redirect("/app");
  return (
    <AuthLayout title="ساخت حساب یارا" lead="بعد از ساخت حساب، حساب لیارای خود را وصل می‌کنید.">
      <AuthForm mode="signup" />
    </AuthLayout>
  );
}
