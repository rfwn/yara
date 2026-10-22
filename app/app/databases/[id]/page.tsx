import { DatabasePage } from "@/components/yara/ResourcePages";

export const metadata = { title: "دیتابیس" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  return <DatabasePage key={id} id={id} />;
}
