"use client";
import { SignOutButton } from "@clerk/nextjs";

export function SignOutLink() {
  return <SignOutButton><button className="link" type="button">Sign out</button></SignOutButton>;
}
