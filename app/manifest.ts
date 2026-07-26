import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Guided Reader",
    short_name: "Reader",
    description:
      "A private read-along space with narration, word highlighting, and comfortable reading controls.",
    start_url: "/",
    display: "standalone",
    background_color: "#f3eee4",
    theme_color: "#9a5b3f",
    orientation: "any",
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
