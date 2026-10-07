// Panelin küçük ortak parçaları.

/** Açık/kapalı anahtarı (taslaktaki "Lina açık" anahtarı): tarayıcının varsayılan onay kutusu yerine. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}

/** Taslaktaki sekmeli seçici (Bugün / Son 7 gün / Son 30 gün): birkaç seçenekten biri seçilir. */
export function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (next: T) => void }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="tab" aria-selected={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
