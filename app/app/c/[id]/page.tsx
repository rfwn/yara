import { redirect } from "next/navigation";

// Conversations now open in the workbench's Yara panel.
export default async function LegacyChatPage({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/app?chat=${encodeURIComponent((await params).id)}`);
}
