export interface Ruta {
  metodo: 'GET' | 'POST' | 'PUT' | 'DELETE';
  ruta: string;
  cuerpo?: any;
}

export const RUTAS_CON_SESION: Ruta[] = [
  { metodo: 'GET', ruta: '/api/yo' },
  { metodo: 'GET', ruta: '/api/mis-cursos' },
  { metodo: 'POST', ruta: '/api/logout' },
  { metodo: 'POST', ruta: '/api/reautenticacion/codigo' },
  { metodo: 'POST', ruta: '/api/reautenticacion/verificar', cuerpo: { codigo: '123456' } },
];

export const RUTAS_ADMIN: Ruta[] = [
  { metodo: 'GET', ruta: '/api/admin/universidad' },
  { metodo: 'GET', ruta: '/api/admin/personas' },
  { metodo: 'PUT', ruta: '/api/admin/personas/1/profesor', cuerpo: { profesor: true } },
  { metodo: 'POST', ruta: '/api/admin/invitaciones', cuerpo: { email: 'x@austral.edu.ar', tipo: 'profesor' } },
  { metodo: 'GET', ruta: '/api/admin/cursos' },
  { metodo: 'POST', ruta: '/api/admin/dominios', cuerpo: { dominio: 'robado.edu.ar' } },
  { metodo: 'DELETE', ruta: '/api/admin/dominios/austral.edu.ar' },
  { metodo: 'GET', ruta: '/api/admin/auditoria' },
];

export const RUTAS_OWNER: Ruta[] = [
  { metodo: 'GET', ruta: '/api/owner/universidades' },
  { metodo: 'POST', ruta: '/api/owner/universidades', cuerpo: { nombre: 'Trucha', dominio: 'trucha.edu.ar', email_administrador: 'yo@trucha.edu.ar' } },
  { metodo: 'POST', ruta: '/api/owner/universidades/1/administradores', cuerpo: { email: 'x@austral.edu.ar' } },
  { metodo: 'GET', ruta: '/api/owner/uso' },
  { metodo: 'GET', ruta: '/api/owner/proveedores' },
  { metodo: 'PUT', ruta: '/api/owner/proveedores', cuerpo: { modelo: 'suscripcion', email: 'resend' } },
];

export const RUTAS_SENSIBLES: Ruta[] = [
  { metodo: 'PUT', ruta: '/api/admin/personas/{persona}/profesor', cuerpo: { profesor: true } },
  { metodo: 'POST', ruta: '/api/admin/invitaciones', cuerpo: { email: '{nuevo}@austral.edu.ar', tipo: 'profesor' } },
  { metodo: 'POST', ruta: '/api/admin/invitaciones', cuerpo: { email: '{nuevo}@austral.edu.ar', tipo: 'administrador' } },
  { metodo: 'DELETE', ruta: '/api/admin/dominios/mail.austral.edu.ar' },
];

export const RUTAS_SENSIBLES_OWNER: Ruta[] = [
  { metodo: 'POST', ruta: '/api/owner/universidades', cuerpo: { nombre: 'Sin reaut', dominio: '{nuevo}.edu.ar', email_administrador: 'a@{nuevo}.edu.ar' } },
  { metodo: 'POST', ruta: '/api/owner/universidades/{uni}/administradores', cuerpo: { email: '{nuevo}@demo.edu.ar' } },
];
