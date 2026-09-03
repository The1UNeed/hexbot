import { NextResponse } from "next/server";
import { getJwks } from "@/lib/tokens";
export async function GET() { return NextResponse.json(await getJwks(), { headers: { "Cache-Control": "public, max-age=300" } }); }
