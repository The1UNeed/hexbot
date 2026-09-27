import Link from "next/link";

export default function NotFound() {
  return (
    <div className="page narrow center">
      <h1 className="display-sm" style={{ fontSize: "2rem" }}>There is nothing here</h1>
      <p className="mute" style={{ marginTop: ".75rem" }}>The address may be old or mistyped.</p>
      <p style={{ marginTop: "1.5rem" }}><Link className="button" href="/connect">Your daemons</Link></p>
    </div>
  );
}
