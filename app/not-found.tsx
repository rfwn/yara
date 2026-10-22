import Link from "next/link";
import { AuthLayout } from "@/components/yara/AuthLayout";

export default function NotFound() {
  return (
    <AuthLayout title="این صفحه پیدا نشد" lead="نشانی اشتباه است یا گفت‌وگو حذف شده است.">
      <Link href="/app" className="btn btn-primary btn-lg btn-block">
        بازگشت به یارا
      </Link>
    </AuthLayout>
  );
}
