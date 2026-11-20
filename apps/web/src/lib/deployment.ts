import { deploymentEdition, deploymentFeatures } from '@videoq/domain/deployment';

export const isOnprem = import.meta.env.VITE_DEPLOYMENT_EDITION === 'onprem';
export const features = deploymentFeatures(deploymentEdition(import.meta.env.VITE_DEPLOYMENT_EDITION));
