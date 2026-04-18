// TODO: Add ConvexProvider wrapping and global styles
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Convex Sandbox Chatbot",
  description: "Chatbot with isolated Daytona VM per conversation thread",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // TODO: Wrap with ConvexProvider using NEXT_PUBLIC_CONVEX_URL
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
