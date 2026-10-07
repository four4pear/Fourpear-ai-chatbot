// Panelin küçük ortak parçaları.

/** Açık/kapalı anahtarı (taslaktaki "Lina açık" anahtarı): tarayıcının varsayılan onay kutusu yerine. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}
