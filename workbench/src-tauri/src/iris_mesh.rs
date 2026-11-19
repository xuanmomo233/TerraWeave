use crate::{iris_context::gl, iris_pack::Program};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::collections::HashMap;
use std::ffi::c_void;
use std::io::Cursor;

#[derive(Deserialize)]
pub struct SceneSource {
    pub atlas: String,
    pub sun: String,
    pub moon: String,
    pub origin: [i32; 3],
    pub models: Vec<Model>,
    pub batches: Vec<Batch>,
    pub light: Vec<LightChunkSource>,
}
#[derive(Deserialize)]
pub struct Model {
    pub positions: Vec<f32>,
    pub uvs: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Option<Vec<usize>>,
    pub rect: [f32; 4],
    pub color: [u8; 3],
    pub stage: String,
}
#[derive(Deserialize)]
pub struct Batch {
    pub model: usize,
    pub entity: f32,
    pub positions: Vec<[i32; 3]>,
}
#[derive(Deserialize)]
pub struct LightChunkSource {
    x: i32,
    z: i32,
    top: Option<Vec<i32>>,
    sections: Vec<SectionSource>,
}
#[derive(Deserialize)]
struct SectionSource {
    y: i32,
    block: Option<String>,
    sky: Option<String>,
}
struct LightSection {
    block: Option<Vec<u8>>,
    sky: Option<Vec<u8>>,
}
struct LightChunk {
    top: Option<Vec<i32>>,
    sections: HashMap<i32, LightSection>,
}
type Light = HashMap<(i32, i32), LightChunk>;

fn light_data(value: Option<String>) -> Result<Option<Vec<u8>>, String> {
    value
        .map(|s| {
            let bytes = STANDARD.decode(s).map_err(|_| "光照数据不是 Base64")?;
            if bytes.len() != 2048 {
                return Err("区块光照数组大小错误".into());
            }
            Ok(bytes)
        })
        .transpose()
}
fn make_light(sources: Vec<LightChunkSource>) -> Result<Light, String> {
    let mut result = HashMap::new();
    for c in sources {
        if c.top.as_ref().is_some_and(|h| h.len() != 256) {
            return Err("存档高度图大小错误".into());
        }
        let mut sections = HashMap::new();
        for s in c.sections {
            sections.insert(
                s.y,
                LightSection {
                    block: light_data(s.block)?,
                    sky: light_data(s.sky)?,
                },
            );
        }
        result.insert(
            (c.x, c.z),
            LightChunk {
                top: c.top,
                sections,
            },
        );
    }
    Ok(result)
}
fn nibble(data: Option<&[u8]>, index: usize) -> Option<u8> {
    data.map(|d| (d[index / 2] >> ((index % 2) * 4)) & 15)
}
fn sample_light(world: &Light, p: [i32; 3]) -> [u8; 2] {
    let [x, y, z] = p;
    let Some(c) = world.get(&(x.div_euclid(16), z.div_euclid(16))) else {
        return [0, 15];
    };
    let local = (z.rem_euclid(16) * 16 + x.rem_euclid(16)) as usize;
    let index = (y.rem_euclid(16) as usize) * 256 + local;
    let s = c.sections.get(&y.div_euclid(16));
    let outside = c.top.as_ref().is_some_and(|top| y >= top[local]);
    [
        nibble(s.and_then(|s| s.block.as_deref()), index).unwrap_or(0),
        nibble(s.and_then(|s| s.sky.as_deref()), index).unwrap_or(if outside { 15 } else { 0 }),
    ]
}

#[repr(C)]
struct Vertex {
    position: [f32; 3],
    normal: [i8; 4],
    uv: [f32; 2],
    color: [u8; 4],
    // These are vanilla lightmap texel coordinates, transformed by GL_TEXTURE1.
    light: [i16; 2],
    entity: f32,
    midpoint: [f32; 2],
    tangent: [i8; 4],
}

struct Mesh {
    handle: u32,
    count: i32,
}
impl Mesh {
    fn upload(vertices: &[Vertex]) -> Self {
        let mut handle = 0;
        unsafe {
            gl::GenBuffers(1, &mut handle);
            gl::BindBuffer(gl::ARRAY_BUFFER, handle);
            gl::BufferData(
                gl::ARRAY_BUFFER,
                std::mem::size_of_val(vertices) as isize,
                vertices.as_ptr().cast(),
                gl::STATIC_DRAW,
            );
            gl::BindBuffer(gl::ARRAY_BUFFER, 0);
        }
        Self {
            handle,
            count: vertices.len() as i32,
        }
    }
    fn draw(&self, program: &Program) {
        let stride = std::mem::size_of::<Vertex>() as i32;
        let offset = |n: usize| n as *const c_void;
        unsafe {
            gl::BindBuffer(gl::ARRAY_BUFFER, self.handle);
            gl::EnableClientState(gl::VERTEX_ARRAY);
            gl::VertexPointer(
                3,
                gl::FLOAT,
                stride,
                offset(std::mem::offset_of!(Vertex, position)),
            );
            gl::EnableClientState(gl::NORMAL_ARRAY);
            gl::NormalPointer(
                gl::BYTE,
                stride,
                offset(std::mem::offset_of!(Vertex, normal)),
            );
            gl::EnableClientState(gl::COLOR_ARRAY);
            gl::ColorPointer(
                4,
                gl::UNSIGNED_BYTE,
                stride,
                offset(std::mem::offset_of!(Vertex, color)),
            );
            gl::ClientActiveTexture(gl::TEXTURE0);
            gl::EnableClientState(gl::TEXTURE_COORD_ARRAY);
            gl::TexCoordPointer(
                2,
                gl::FLOAT,
                stride,
                offset(std::mem::offset_of!(Vertex, uv)),
            );
            gl::ClientActiveTexture(gl::TEXTURE1);
            gl::EnableClientState(gl::TEXTURE_COORD_ARRAY);
            gl::TexCoordPointer(
                2,
                gl::SHORT,
                stride,
                offset(std::mem::offset_of!(Vertex, light)),
            );
            let attributes = [
                (
                    program.entity,
                    1,
                    gl::FLOAT,
                    gl::FALSE,
                    std::mem::offset_of!(Vertex, entity),
                ),
                (
                    program.midpoint,
                    2,
                    gl::FLOAT,
                    gl::FALSE,
                    std::mem::offset_of!(Vertex, midpoint),
                ),
                (
                    program.tangent,
                    4,
                    gl::BYTE,
                    gl::TRUE,
                    std::mem::offset_of!(Vertex, tangent),
                ),
            ];
            for (loc, count, kind, normalize, at) in attributes {
                if loc < 0 {
                    continue;
                }
                gl::EnableVertexAttribArray(loc as u32);
                gl::VertexAttribPointer(loc as u32, count, kind, normalize, stride, offset(at));
            }
            gl::DrawArrays(gl::TRIANGLES, 0, self.count);
            for (loc, ..) in attributes {
                if loc >= 0 {
                    gl::DisableVertexAttribArray(loc as u32);
                }
            }
            gl::DisableClientState(gl::TEXTURE_COORD_ARRAY);
            gl::ClientActiveTexture(gl::TEXTURE0);
            gl::DisableClientState(gl::TEXTURE_COORD_ARRAY);
            gl::DisableClientState(gl::COLOR_ARRAY);
            gl::DisableClientState(gl::NORMAL_ARRAY);
            gl::DisableClientState(gl::VERTEX_ARRAY);
            gl::BindBuffer(gl::ARRAY_BUFFER, 0);
        }
    }
}
impl Drop for Mesh {
    fn drop(&mut self) {
        unsafe {
            gl::DeleteBuffers(1, &self.handle);
        }
    }
}

pub struct Texture(pub u32);
impl Texture {
    pub fn rgba(width: i32, height: i32, data: &[u8], repeat: bool) -> Self {
        let mut id = 0;
        unsafe {
            gl::GenTextures(1, &mut id);
            gl::BindTexture(gl::TEXTURE_2D, id);
            gl::TexImage2D(
                gl::TEXTURE_2D,
                0,
                gl::RGBA8 as i32,
                width,
                height,
                0,
                gl::RGBA,
                gl::UNSIGNED_BYTE,
                data.as_ptr().cast(),
            );
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::NEAREST as i32);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::NEAREST as i32);
            let wrap = if repeat {
                gl::REPEAT
            } else {
                gl::CLAMP_TO_EDGE
            };
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, wrap as i32);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, wrap as i32);
        }
        Self(id)
    }
    pub(crate) fn png(encoded: &str) -> Result<Self, String> {
        let data = encoded
            .strip_prefix("data:image/png;base64,")
            .ok_or("贴图必须为 PNG")?;
        if data.len() > 24_000_000 {
            return Err("贴图超出大小限制".into());
        }
        let bytes = STANDARD.decode(data).map_err(|_| "贴图 Base64 无效")?;
        let mut decoder = png::Decoder::new(Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
        if reader.info().width > 4096 || reader.info().height > 4096 {
            return Err("贴图尺寸超出限制".into());
        }
        let mut buffer =
            vec![0; reader.output_buffer_size().ok_or("PNG 图片超出大小限制")?];
        let info = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
        let width = info.width as usize;
        let height = info.height as usize;
        let mut rgba = Vec::with_capacity(width * height * 4);
        for y in (0..height).rev() {
            let row = &buffer[y * info.line_size..(y + 1) * info.line_size];
            match info.color_type {
                png::ColorType::Rgba => rgba.extend_from_slice(row),
                png::ColorType::Rgb => {
                    for p in row.chunks_exact(3) {
                        rgba.extend_from_slice(&[p[0], p[1], p[2], 255]);
                    }
                }
                png::ColorType::Grayscale => {
                    for c in row {
                        rgba.extend_from_slice(&[*c, *c, *c, 255]);
                    }
                }
                png::ColorType::GrayscaleAlpha => {
                    for p in row.chunks_exact(2) {
                        rgba.extend_from_slice(&[p[0], p[0], p[0], p[1]]);
                    }
                }
                _ => return Err("PNG 颜色格式不受支持".into()),
            }
        }
        Ok(Self::rgba(
            info.width as i32,
            info.height as i32,
            &rgba,
            false,
        ))
    }
}
impl Drop for Texture {
    fn drop(&mut self) {
        unsafe {
            gl::DeleteTextures(1, &self.0);
        }
    }
}

type Vec3 = [f32; 3];
fn point(values: &[f32], i: usize) -> Vec3 {
    [values[i * 3], values[i * 3 + 1], values[i * 3 + 2]]
}
fn normal(v: Vec3) -> Vec3 {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len > 1e-8 {
        v.map(|n| n / len)
    } else {
        [0., 1., 0.]
    }
}
fn subtract(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn quantize(v: f32) -> i8 {
    (v.clamp(-1., 1.) * 127.).round() as i8
}

struct Triangle {
    vertices: [usize; 3],
    tangent: [i8; 4],
    midpoint: [f32; 2],
}
impl Model {
    fn count(&self) -> usize {
        self.indices
            .as_ref()
            .map_or(self.positions.len() / 3, Vec::len)
    }
    fn triangles(&self) -> Result<Vec<Triangle>, String> {
        let n = self.positions.len() / 3;
        if self.positions.len() != n * 3
            || self.normals.len() != n * 3
            || self.uvs.len() != n * 2
            || self.count() % 3 != 0
            || self
                .indices
                .as_ref()
                .is_some_and(|ids| ids.iter().any(|i| *i >= n))
        {
            return Err("离线方块网格顶点或索引无效".into());
        }
        let index = |i| self.indices.as_ref().map_or(i, |ids| ids[i]);
        let mut result = Vec::new();
        for i in (0..self.count()).step_by(3) {
            let vertices = [index(i), index(i + 1), index(i + 2)];
            let [a, b, c] = vertices.map(|i| point(&self.positions, i));
            let [u0, u1, u2] = vertices.map(|i| self.uvs[i * 2]);
            let [v0, v1, v2] = vertices.map(|i| self.uvs[i * 2 + 1]);
            let d0 = subtract(b, a);
            let d1 = subtract(c, a);
            let [du0, du1, dv0, dv1] = [u1 - u0, u2 - u0, v1 - v0, v2 - v0];
            let det = du0 * dv1 - du1 * dv0;
            let n = normal(point(&self.normals, vertices[0]));
            let (t, b) = if det.abs() > 1e-8 {
                (
                    normal(std::array::from_fn(|i| (d0[i] * dv1 - d1[i] * dv0) / det)),
                    normal(std::array::from_fn(|i| (d1[i] * du0 - d0[i] * du1) / det)),
                )
            } else {
                let t = normal(cross(
                    if n[1].abs() > 0.9 {
                        [0., 0., 1.]
                    } else {
                        [0., 1., 0.]
                    },
                    n,
                ));
                (t, cross(n, t))
            };
            let bitangent = cross(n, t);
            let w = if bitangent.iter().zip(b).map(|(x, y)| x * y).sum::<f32>() < 0. {
                -127
            } else {
                127
            };
            let mid = |a: f32, b: f32, c: f32| (a.min(b).min(c) + a.max(b).max(c)) * 0.5;
            let midpoint = self.atlas_uv([mid(u0, u1, u2), mid(v0, v1, v2)]);
            result.push(Triangle {
                vertices,
                tangent: [quantize(t[0]), quantize(t[1]), quantize(t[2]), w],
                midpoint,
            });
        }
        Ok(result)
    }
    fn atlas_uv(&self, uv: [f32; 2]) -> [f32; 2] {
        [
            self.rect[0] + uv[0] * self.rect[2],
            self.rect[1] + uv[1] * self.rect[3],
        ]
    }
}

pub struct Scene {
    pub atlas: Texture,
    pub sun: Texture,
    pub moon: Texture,
    meshes: HashMap<String, Mesh>,
    pub vertices: usize,
    light: Light,
}
impl Scene {
    pub fn upload(source: SceneSource) -> Result<Self, String> {
        if source.models.len() > 20_000
            || source.batches.len() > 100_000
            || source.light.len() > 2000
        {
            return Err("离线场景超出网格限制".into());
        }
        let light = make_light(source.light)?;
        let atlas = Texture::png(&source.atlas)?;
        let sun = Texture::png(&source.sun)?;
        let moon = Texture::png(&source.moon)?;
        let models = source.models;
        let triangles = models
            .iter()
            .map(Model::triangles)
            .collect::<Result<Vec<_>, _>>()?;
        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut vertices = 0;
        for b in &source.batches {
            let m = models.get(b.model).ok_or("离线模型索引越界")?;
            let n = m
                .count()
                .checked_mul(b.positions.len())
                .ok_or("离线场景超出顶点限制")?;
            vertices = usize::checked_add(vertices, n).ok_or("离线场景超出顶点限制")?;
            if vertices > 7_000_000 {
                return Err("离线场景超出顶点限制".into());
            }
            *counts.entry(m.stage.clone()).or_insert(0) += n;
        }
        let mut meshes = HashMap::new();
        // Allocate and release each staging buffer independently.
        for (stage, count) in counts {
            if !matches!(
                stage.as_str(),
                "gbuffers_terrain" | "gbuffers_block" | "gbuffers_water"
            ) {
                return Err(format!("未知的方块渲染阶段 {stage}"));
            }
            let mut buffer = Vec::with_capacity(count);
            for batch in source
                .batches
                .iter()
                .filter(|b| models[b.model].stage == stage)
            {
                let model = &models[batch.model];
                for p in &batch.positions {
                    let local =
                        std::array::from_fn::<_, 3, _>(|i| (p[i] - source.origin[i]) as f32);
                    for tri in &triangles[batch.model] {
                        let n = point(&model.normals, tri.vertices[0]);
                        // Face lighting is sampled from the saved neighbor that the
                        // exposed quad faces. Partial/diagonal models can also see
                        // their own cell's light level.
                        let neighbor = std::array::from_fn(|i| p[i] + n[i].round() as i32);
                        let own = sample_light(&light, *p);
                        let other = sample_light(&light, neighbor);
                        let brightness = [
                            16 * i16::from(own[0].max(other[0])),
                            16 * i16::from(own[1].max(other[1])),
                        ];
                        for i in tri.vertices {
                            let v = point(&model.positions, i);
                            let normal = point(&model.normals, i);
                            buffer.push(Vertex {
                                position: std::array::from_fn(|j| local[j] + v[j]),
                                normal: [
                                    quantize(normal[0]),
                                    quantize(normal[1]),
                                    quantize(normal[2]),
                                    0,
                                ],
                                uv: model.atlas_uv([model.uvs[i * 2], model.uvs[i * 2 + 1]]),
                                color: [model.color[0], model.color[1], model.color[2], 255],
                                light: brightness,
                                entity: batch.entity,
                                midpoint: tri.midpoint,
                                tangent: tri.tangent,
                            });
                        }
                    }
                }
            }
            if !buffer.is_empty() {
                meshes.insert(stage, Mesh::upload(&buffer));
            }
        }
        Ok(Self {
            atlas,
            sun,
            moon,
            meshes,
            vertices,
            light,
        })
    }
    pub fn draw(&self, stage: &str, program: &Program) -> bool {
        if let Some(mesh) = self.meshes.get(stage) {
            mesh.draw(program);
            true
        } else {
            false
        }
    }
    pub fn eye_light(&self, camera: [f32; 3]) -> [i32; 2] {
        sample_light(&self.light, camera.map(|n| n.floor() as i32))
            .map(|value| i32::from(value) * 16)
    }
}
