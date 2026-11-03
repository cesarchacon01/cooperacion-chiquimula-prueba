# Procedencia de `limites_chiquimula.geojson`

**Qué es:** copia local de respaldo de los 11 límites municipales de Chiquimula, usada por el visor solo cuando el servicio de CONRED no responde. **No es una capa oficial certificada**; es una referencia cartográfica pública de buena calidad.

**Fuente primaria:** repositorio público `minfin-bi/Mapas-TopoJSON-Guatemala` (cuenta de BI del Ministerio de Finanzas Públicas), archivo `munis.json`, commit `f7f11abeee5628131096f2e09072789f932de7b0` (31-ago-2022). SHA-256 del archivo original: `e34bfeec…e0c9c0`. Licencia: no declarada en el repositorio; confirmar permiso de uso/redistribución con MINFIN antes de publicar.

**Contraste:** repositorio `Edgar-Rivera/guatemala-mapa-municipios-topojson` (commit `a716c5e42876fb297ff9b9da72f7e5ffa19f39f4`, CC BY 4.0; indica haber cotejado nombres y códigos con INE y SEGEPLAN). Los 11 municipios coinciden en nombre, área (razón 0,997–1,003) y extensión (diferencias < 0,001°). Ojo: la coincidencia sugiere un origen común y **no constituye una validación independiente**.

**Transformación:** TopoJSON → GeoJSON; se conservaron solo los 11 municipios del departamento Chiquimula; coordenadas redondeadas a 5 decimales (~1 m); propiedades normalizadas al esquema de CONRED que usa el visor (`nombre_1`, `depto_1`, `cod_dept_1`, `cod_muni_1` con código INE) y `nombre_fuente`/`fuente`. `nombre_1` usa la misma escritura que el selector de municipios del visor.

**Validación de ubicación (816 lugares con coordenadas):** 790 caen dentro de su municipio según estos límites (96,8 %). 26 caen fuera: 18 a menos de 500 m del borde (imprecisión normal de límites/coordenadas), 8 entre 500 m y 1,3 km. Listado en `puntos_fuera_de_limite.csv` para verificación en campo o con SEGEPLAN. No se modificó ninguna coordenada.

**Pendiente:** reemplazar por la capa oficial (SEGEPLAN/IGN/CONRED) cuando se pueda descargar y verificar, y confirmar la licencia.
