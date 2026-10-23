import { InMemoryChannelLayer } from '../src';
import { layerContract } from './contract';

layerContract('InMemoryChannelLayer', (options) => new InMemoryChannelLayer(options));
