import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Telestorage",
    short_name: "Telestorage",
    description: "Cloud storage on your own private Telegram channel",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#efeae1",
    theme_color: "#efeae1",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
    categories: ["productivity", "utilities"],
    // Installed on a phone, Telestorage shows up in the share sheet: share
    // photos or files from any app straight into a folder.
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: { title: "title", text: "text", url: "url", files: [{ name: "files", accept: ["*/*"] }] },
    },
    shortcuts: [
      { name: "Upload files", url: "/files?upload=1", icons: [{ src: "/icon.svg", sizes: "any" }] },
      { name: "Photos", url: "/photos", icons: [{ src: "/icon.svg", sizes: "any" }] },
    ],
  } as MetadataRoute.Manifest;
}
