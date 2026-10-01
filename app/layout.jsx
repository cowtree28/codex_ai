import "../style.css";

export const metadata = {
  title: "check — 일정 관리",
  description: "개인 일정과 할 일을 관리하는 앱",
};

export default function RootLayout({ children }) {
  return <html lang="ko"><body>{children}</body></html>;
}
