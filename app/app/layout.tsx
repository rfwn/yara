import "@xterm/xterm/css/xterm.css";
import "../workbench.css";
import { Workbench } from "@/components/yara/Workbench";
import { DEFAULT_MODEL, MODELS } from "@/lib/models";
import { requireUser } from "@/lib/server/auth";
import { listChats } from "@/lib/server/chats";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser({ needToken: true });
  const modelId = user.model ?? DEFAULT_MODEL;
  return (
    <Workbench
      user={{ name: user.name, email: user.email, teamID: user.teamID }}
      initialCases={listChats(user.id)}
      modelLabel={MODELS.find((m) => m.id === modelId)?.label ?? modelId}
    >
      {children}
    </Workbench>
  );
}
