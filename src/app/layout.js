export const metadata = {
  title: 'Peitão de Pombo API',
  description: 'Backend do app Peitão de Pombo'
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
