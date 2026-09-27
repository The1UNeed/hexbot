import { forward } from "@/lib/posthog-proxy";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path: string[] }> };
const handler = async (request: Request, context: Context) => forward(request, (await context.params).path);
export { handler as GET, handler as POST };
