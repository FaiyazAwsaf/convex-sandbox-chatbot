import type { Metadata } from "next";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { ErrorBoundary } from "./ErrorBoundary";
import "./globals.css";

export const metadata: Metadata = {
  title: "Convex Sandbox Chatbot",
  description: "Chatbot with isolated Daytona VM per conversation thread",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 h-screen overflow-hidden">
        <ConvexClientProvider>
          <ErrorBoundary>{children}</ErrorBoundary>
        </ConvexClientProvider>
      </body>
    </html>
  );
}
