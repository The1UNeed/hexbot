import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "./styles.css";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { ConsentNotice, Identity } from "@/components/consent";
import { authMode, currentClerkUserId } from "@/lib/auth";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.CONNECT_BASE_URL ?? "https://connect.hexbot.app"),
  title: { default: "Hexbot Connect", template: "%s | Hexbot Connect" },
  description: "Sign in once and reach your Hexbot from anywhere, in the app or in a browser. Connect brokers your identity and a hostname; your conversations never pass through it.",
  openGraph: { siteName: "Hexbot Connect", images: ["/og.png"] },
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
};

// Clerk's components take the site's tokens so the sign-in card reads as part of the page.
const appearance = {
  variables: {
    colorPrimary: "#141414",
    colorBackground: "#ffffff",
    colorForeground: "#141414",
    colorMutedForeground: "#6b6b70",
    colorInput: "#ffffff",
    colorInputForeground: "#141414",
    colorDanger: "#d92d20",
    colorSuccess: "#16a34a",
    colorBorder: "#e6e6e8",
    colorRing: "#4f46e5",
    borderRadius: "12px",
    fontFamily: "'Bricolage Grotesque Variable', 'Helvetica Neue', Arial, sans-serif",
    fontSize: "15px",
  },
  elements: {
    cardBox: { boxShadow: "none", border: "1px solid #e6e6e8", borderRadius: "20px" },
    formButtonPrimary: { borderRadius: "999px", textTransform: "none", fontWeight: 600, fontSize: "15px" },
    socialButtonsBlockButton: { borderRadius: "999px" },
    footer: { background: "#f5f5f5" },
  },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const userId = await currentClerkUserId();
  const body = (
    <html lang="en">
      <body>
        <Header />
        <main>{children}</main>
        <Footer />
        <ConsentNotice />
        <Identity userId={userId} />
      </body>
    </html>
  );
  return authMode() === "clerk"
    ? <ClerkProvider appearance={appearance} signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/connect" signUpFallbackRedirectUrl="/connect" afterSignOutUrl="/">{body}</ClerkProvider>
    : body;
}
