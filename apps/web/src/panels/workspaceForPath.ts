import type { WorkspacePathMatch } from "@thinkrail/contracts";
import { getTransport } from "../transport";

export function resolveWorkspaceFile(path: string): Promise<WorkspacePathMatch | null> {
	return getTransport().request("workspace.resolvePath", { path });
}
