export const metadata = {
  title: "NSE Market Research MCP",
  description: "MCP server exposing NSE India market data tools for equity research",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}