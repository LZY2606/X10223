import { migrationY, LADDER_NOMINAL } from '../src/core/gelgen';
for (const bp of [4200,1800,900,2500,1200,1700,1550,700,2200,6000,800,3500,950,460]) console.log(bp, Math.round(migrationY(bp)));
