pub const REEMPLAZO: &[u8] = b"[token-oculto]";

pub fn reemplazar_todo(texto: &[u8], secreto: &[u8]) -> Option<Vec<u8>> {
    if secreto.is_empty() || texto.len() < secreto.len() {
        return None;
    }
    let mut salida = Vec::with_capacity(texto.len());
    let mut inicio = 0;
    let mut cambio = false;
    while let Some(pos) = buscar(&texto[inicio..], secreto) {
        salida.extend_from_slice(&texto[inicio..inicio + pos]);
        salida.extend_from_slice(REEMPLAZO);
        inicio += pos + secreto.len();
        cambio = true;
    }
    if !cambio {
        return None;
    }
    salida.extend_from_slice(&texto[inicio..]);
    Some(salida)
}

fn buscar(pajar: &[u8], aguja: &[u8]) -> Option<usize> {
    if aguja.len() > pajar.len() {
        return None;
    }
    pajar.windows(aguja.len()).position(|v| v == aguja)
}

pub struct Censor {
    secreto: Vec<u8>,
    pendiente: Vec<u8>,
}

impl Censor {
    pub fn new(secreto: Vec<u8>) -> Self {
        Censor { secreto, pendiente: Vec::new() }
    }

    pub fn procesar(&mut self, trozo: &[u8]) -> Vec<u8> {
        let mut datos = std::mem::take(&mut self.pendiente);
        datos.extend_from_slice(trozo);
        let mut salida = Vec::with_capacity(datos.len());
        let mut inicio = 0;
        while let Some(pos) = buscar(&datos[inicio..], &self.secreto) {
            salida.extend_from_slice(&datos[inicio..inicio + pos]);
            salida.extend_from_slice(REEMPLAZO);
            inicio += pos + self.secreto.len();
        }
        let resto = &datos[inicio..];
        let retener = self.prefijo_al_final(resto);
        salida.extend_from_slice(&resto[..resto.len() - retener]);
        self.pendiente = resto[resto.len() - retener..].to_vec();
        salida
    }

    pub fn terminar(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pendiente)
    }

    fn prefijo_al_final(&self, resto: &[u8]) -> usize {
        let maximo = resto.len().min(self.secreto.len().saturating_sub(1));
        (1..=maximo)
            .rev()
            .find(|&k| resto[resto.len() - k..] == self.secreto[..k])
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn partido_en_trozos() {
        let secreto = b"sk-ant-oat01-SECRETO".to_vec();
        let texto = b"aaa sk-ant-oat01-SECRETO bbb sk-ant-oat01-SECRETO".to_vec();
        for corte in 0..texto.len() {
            for corte2 in corte..texto.len() {
                let mut c = Censor::new(secreto.clone());
                let mut salida = c.procesar(&texto[..corte]);
                salida.extend(c.procesar(&texto[corte..corte2]));
                salida.extend(c.procesar(&texto[corte2..]));
                salida.extend(c.terminar());
                assert_eq!(salida, b"aaa [token-oculto] bbb [token-oculto]".to_vec());
            }
        }
    }

    #[test]
    fn byte_a_byte() {
        let secreto = b"sk-sk-sk-x".to_vec();
        let texto = b"sk-sk-sk-sk-x sk-sk".to_vec();
        let mut c = Censor::new(secreto);
        let mut salida = Vec::new();
        for b in &texto {
            salida.extend(c.procesar(&[*b]));
        }
        salida.extend(c.terminar());
        assert_eq!(salida, b"sk-[token-oculto] sk-sk".to_vec());
    }
}
