import { type NextRequest } from "next/server";
import { handleOtaRequest, type DeviceSystemInfo } from "@/services/xiaozhi/ota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function jsonResponse(body: unknown, status = 200): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
      "Connection": "close",
    },
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const raw = await request.text();
  if (raw.trim().length === 0) {
    return jsonResponse({ error: "empty body" }, 400);
  }

  let info: DeviceSystemInfo;
  try {
    info = JSON.parse(raw) as DeviceSystemInfo;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (!info.mac_address || !info.uuid) {
    return jsonResponse({ error: "mac_address and uuid are required" }, 400);
  }

  const response = await handleOtaRequest(info);
  return jsonResponse(response);
}

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const mac = url.searchParams.get("mac_address");
  const uuid = url.searchParams.get("uuid");
  if (!mac || !uuid) {
    return jsonResponse(
      { error: "mac_address and uuid query params required" },
      400,
    );
  }

  const response = await handleOtaRequest({
    mac_address: mac,
    uuid,
  } as DeviceSystemInfo);
  return jsonResponse(response);
}
