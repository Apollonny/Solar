import brandBoard from '../../../../docs/solar-brand-reference.png'

/** Displays the supplied wordmark directly from its original brand sheet. */
export function BrandWordmark(): React.JSX.Element {
  return <span className="solar-wordmark" role="img" aria-label="Solar" style={{ backgroundImage: `url(${brandBoard})` }} />
}
