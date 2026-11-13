export const DOMINIO = 'campusia.prueba';
export const COOKIE_SESION = 'campusia_sesion';

export const OWNER = 'equipo@campusia.prueba';
export const ADMIN_AUSTRAL = 'ana.morales@austral.edu.ar';
export const PROFE_AUSTRAL = 'lfernandez@austral.edu.ar';
export const PROFE2_AUSTRAL = 'dherrera@austral.edu.ar';
export const ALUMNO_AUSTRAL = 'tgarcia@mail.austral.edu.ar';
export const ADMIN_DEMO = 'admin@demo.edu.ar';
export const PROFE_DEMO = 'profe@demo.edu.ar';
export const ALUMNO_DEMO = 'alumno@demo.edu.ar';

export const SEMILLA = {
  universidades: [
    { nombre: 'Universidad Austral', dominios: ['austral.edu.ar', 'mail.austral.edu.ar'], limite_usd: 40 },
    { nombre: 'Universidad de Prueba', dominios: ['demo.edu.ar'], limite_usd: 20 },
  ],
  usuarios: [
    { email: ADMIN_AUSTRAL, nombre: 'Ana Morales', universidad: 'Universidad Austral', administrador: true },
    { email: PROFE_AUSTRAL, nombre: 'Lucía Fernández', universidad: 'Universidad Austral', profesor: true },
    { email: PROFE2_AUSTRAL, nombre: 'Diego Herrera', universidad: 'Universidad Austral', profesor: true },
    { email: ALUMNO_AUSTRAL, nombre: 'Tomás García', universidad: 'Universidad Austral' },
    { email: ADMIN_DEMO, nombre: 'Admin Demo', universidad: 'Universidad de Prueba', administrador: true },
    { email: PROFE_DEMO, nombre: 'Profe Demo', universidad: 'Universidad de Prueba', profesor: true },
    { email: ALUMNO_DEMO, nombre: 'Alumno Demo', universidad: 'Universidad de Prueba' },
  ],
  cursos: [],
};
