import { AppDashboard } from "@/components/yara/AppDashboard";

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) {
  return { title: decodeURIComponent((await params).name) };
}

export default async function AppPage({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  return <AppDashboard key={name} name={name} />;
}
