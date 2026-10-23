import { VMPage } from "@/components/yara/VMPage";

export const metadata = { title: "ماشین مجازی" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  return <VMPage key={id} id={id} />;
}
