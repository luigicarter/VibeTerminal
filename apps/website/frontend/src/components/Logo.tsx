export const Logo = ({ compact = false }: { compact?: boolean }) => (
  <a className="logo" href="/" aria-label="Lina Terminal home">
    <img src="/brand/lina-mark.svg" alt="" width="36" height="36" className="logo__mark" />
    {!compact && <span className="logo__wordmark">Lina<span> Terminal</span></span>}
  </a>
);
