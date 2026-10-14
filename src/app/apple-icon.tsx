import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon: the Telestorage mark (an orange paper plane folded on a storage tile). */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#111111" }}>
        <svg width="150" height="150" viewBox="0 0 40 40">
          <path d="M7 20.5 33 8 26 32 19.5 24.5Z" fill="#f2652a" />
          <path d="M19.5 24.5 33 8 22.5 27.5Z" fill="#efeae1" />
        </svg>
      </div>
    ),
    size,
  );
}
