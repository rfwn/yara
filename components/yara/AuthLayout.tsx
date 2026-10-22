import Link from "next/link";
import { LogoMark } from "./Logo";

export function AuthLayout({ title, lead, wide, children }: { title: string; lead?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className={`auth-card ${wide ? "wide" : ""}`}>
        <div>
          <Link href="/" aria-label="یارا، صفحه‌ی اصلی">
            <LogoMark size={36} />
          </Link>
          <h1 style={{ marginTop: 20 }}>{title}</h1>
          {lead && <p className="lead">{lead}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}
