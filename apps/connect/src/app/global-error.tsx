"use client";
import { useEffect } from "react";
import { captureException } from "@/lib/analytics";

/** Last-resort boundary: report the error (with consent) and offer a retry. Renders its own <html> because the layout itself may have failed. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { captureException(error); }, [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "3rem 1.5rem", maxWidth: "40rem", margin: "0 auto" }}>
        <h1>Something went wrong</h1>
        <p>Hex Connect hit an error it could not recover from.{error.digest ? ` Reference ${error.digest}.` : ""}</p>
        <p><button type="button" onClick={reset} style={{ padding: ".6rem 1.2rem", borderRadius: "999px", border: 0, background: "#141414", color: "#fff", font: "inherit", cursor: "pointer" }}>Try again</button></p>
      </body>
    </html>
  );
}
