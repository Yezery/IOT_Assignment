"use client";

import { useRouter } from "next/navigation";

import { DeleteDeviceButton } from "../_components/DeleteDeviceButton";

export function DeviceActions({
  deviceId,
  displayName,
}: {
  deviceId: string;
  displayName: string;
}): React.ReactElement {
  const router = useRouter();
  return (
    <DeleteDeviceButton
      deviceId={deviceId}
      displayName={displayName}
      onDeleted={() => router.push("/devices")}
    />
  );
}