import { BucketPage } from "@/components/yara/ResourcePages";

export const metadata = { title: "باکت" };

export default async function Page({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  return <BucketPage key={name} name={name} />;
}
