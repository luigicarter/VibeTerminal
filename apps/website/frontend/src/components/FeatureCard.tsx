import type { Feature } from "../types/marketing";

type FeatureCardProps = {
  feature: Feature;
};

export const FeatureCard = ({ feature }: FeatureCardProps) => {
  const Icon = feature.icon;

  return (
    <article className="feature-card">
      <div className="feature-card__icon">
        <Icon size={20} />
      </div>
      <h3>{feature.title}</h3>
      <p>{feature.description}</p>
    </article>
  );
};
