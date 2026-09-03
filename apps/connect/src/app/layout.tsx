import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./styles.css";

export const metadata: Metadata = { title: "Hex Connect", description: "Connect to your Hexbot daemon" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const body = <html lang="en"><body><header><a href="/connect">Hex Connect</a></header><main>{children}</main></body></html>;
  return process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? <ClerkProvider>{body}</ClerkProvider> : body;
}
