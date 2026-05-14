export default function Home() {
  return (
    <main style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'system-ui',
      background: '#0F0F11',
      color: '#EFEFEF'
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ color: '#B41E1E', letterSpacing: 2 }}>Peitão de Pombo · API</h1>
        <p style={{ color: '#888', marginTop: 8 }}>Backend pra app.peitaodepombo.com.br</p>
      </div>
    </main>
  );
}
