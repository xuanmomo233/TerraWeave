use crate::{
    iris_context::{gl, Context},
    iris_mesh::{Scene, SceneSource, Texture},
    iris_pack::{driver, image_format, Pack, PackSources, Program},
};
use serde::Deserialize;
use serde_json::{json, Value};
use base64::{engine::general_purpose::STANDARD,Engine as _};
use std::ptr::null;

const IDENTITY: [f32; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];
type Matrix = [f32; 16];

fn single_sample() -> u8 {
    1
}

#[derive(Clone, Deserialize)]
pub struct DrawFrame {
    pub width: i32,
    pub height: i32,
    pub near: f32,
    pub far: f32,
    pub view: Matrix,
    pub rotation: Matrix,
    pub inverse_rotation: Matrix,
    pub projection: Matrix,
    pub inverse_projection: Matrix,
    pub shadow_view: Matrix,
    pub shadow_rotation: Matrix,
    pub shadow_projection: Matrix,
    pub camera: [f32; 3],
    pub sun: [f32; 3],
    pub up: [f32; 3],
    pub shadow_light: [f32; 3],
    pub sun_world: [f32; 3],
    pub fog_color: [f32; 3],
    pub day_time: i32,
    pub moon_phase: u8,
    pub time_counter: f32,
    pub rain: f32,
    pub biome_temp: f32,
    pub in_swamp: f32,
    pub eye_in_water: i32,
    #[serde(default)]
    pub atlas_update: Option<String>,
    #[serde(default)]
    pub reset_history: bool,
    #[serde(default = "single_sample")]
    pub samples: u8,
}
impl DrawFrame {
    fn validate(&self) -> Result<(), String> {
        if !(1..=1920).contains(&self.width)
            || !(1..=1920).contains(&self.height)
            || !(0.001..self.far).contains(&self.near)
            || !self.far.is_finite()
            || !(1..=16).contains(&self.samples)
        {
            return Err("离线光影视口尺寸或裁剪范围无效".into());
        }
        if [
            &self.view,
            &self.rotation,
            &self.inverse_rotation,
            &self.projection,
            &self.inverse_projection,
            &self.shadow_view,
            &self.shadow_rotation,
            &self.shadow_projection,
        ]
        .iter()
        .flat_map(|m| m.iter())
        .any(|v| !v.is_finite())
        {
            return Err("离线光影相机矩阵无效".into());
        }
        Ok(())
    }
    fn follows(&self, previous: &Self) -> bool {
        let moved = self
            .camera
            .iter()
            .zip(previous.camera)
            .map(|(a, b)| (a - b).powi(2))
            .sum::<f32>();
        let turned = self
            .rotation
            .iter()
            .zip(previous.rotation)
            .map(|(a, b)| (a - b).powi(2))
            .sum::<f32>();
        moved < 64. && turned < 0.5 && self.eye_in_water == previous.eye_in_water
    }
}

struct Framebuffer(u32);
impl Framebuffer {
    fn new() -> Self {
        let mut f = 0;
        unsafe {
            gl::GenFramebuffers(1, &mut f);
            gl::BindFramebuffer(gl::FRAMEBUFFER, f);
            gl::DrawBuffer(gl::NONE);
            gl::ReadBuffer(gl::NONE);
        }
        Self(f)
    }
    fn bind(&self, colors: &[Option<u32>], depth: Option<u32>) -> Result<(), String> {
        unsafe {
            gl::BindFramebuffer(gl::FRAMEBUFFER, self.0);
            for i in 0..8 {
                gl::FramebufferTexture2D(
                    gl::FRAMEBUFFER,
                    gl::COLOR_ATTACHMENT0 + i as u32,
                    gl::TEXTURE_2D,
                    colors.get(i).copied().flatten().unwrap_or(0),
                    0,
                );
            }
            gl::FramebufferTexture2D(
                gl::FRAMEBUFFER,
                gl::DEPTH_ATTACHMENT,
                gl::TEXTURE_2D,
                depth.unwrap_or(0),
                0,
            );
            let draw: Vec<_> = colors
                .iter()
                .enumerate()
                .map(|(i, tex)| {
                    if tex.is_some() {
                        gl::COLOR_ATTACHMENT0 + i as u32
                    } else {
                        gl::NONE
                    }
                })
                .collect();
            if draw.is_empty() {
                gl::DrawBuffer(gl::NONE);
            } else {
                gl::DrawBuffers(draw.len() as i32, draw.as_ptr());
            }
            gl::ReadBuffer(
                draw.iter()
                    .copied()
                    .find(|n| *n != gl::NONE)
                    .unwrap_or(gl::NONE),
            );
            let status = gl::CheckFramebufferStatus(gl::FRAMEBUFFER);
            if status != gl::FRAMEBUFFER_COMPLETE {
                return Err(format!("光影帧缓冲不完整：0x{status:x}"));
            }
        }
        Ok(())
    }
    fn copy_depth_to(
        &self,
        target: &Self,
        depth: u32,
        width: i32,
        height: i32,
    ) -> Result<(), String> {
        target.bind(&[], Some(depth))?;
        unsafe {
            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, self.0);
            gl::BlitFramebuffer(
                0,
                0,
                width,
                height,
                0,
                0,
                width,
                height,
                gl::DEPTH_BUFFER_BIT,
                gl::NEAREST,
            );
            gl::BindFramebuffer(gl::FRAMEBUFFER, self.0);
        }
        Ok(())
    }
}
impl Drop for Framebuffer {
    fn drop(&mut self) {
        unsafe {
            gl::DeleteFramebuffers(1, &self.0);
        }
    }
}

fn buffer_texture(width: i32, height: i32, format: u32, depth: bool) -> Texture {
    let mut id = 0;
    unsafe {
        gl::GenTextures(1, &mut id);
        gl::BindTexture(gl::TEXTURE_2D, id);
        let (layout, kind) = if depth {
            (gl::DEPTH_COMPONENT, gl::UNSIGNED_INT)
        } else {
            (gl::RGBA, gl::FLOAT)
        };
        gl::TexImage2D(
            gl::TEXTURE_2D,
            0,
            format as i32,
            width,
            height,
            0,
            layout,
            kind,
            null(),
        );
        let filter = if depth { gl::NEAREST } else { gl::LINEAR };
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, filter as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, filter as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE as i32);
    }
    Texture(id)
}

fn depth_sampler(compare: bool) -> u32 {
    let mut sampler = 0;
    unsafe {
        gl::GenSamplers(1, &mut sampler);
        let filter = if compare { gl::LINEAR } else { gl::NEAREST };
        gl::SamplerParameteri(sampler, gl::TEXTURE_MIN_FILTER, filter as i32);
        gl::SamplerParameteri(sampler, gl::TEXTURE_MAG_FILTER, filter as i32);
        gl::SamplerParameteri(sampler, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_BORDER as i32);
        gl::SamplerParameteri(sampler, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_BORDER as i32);
        gl::SamplerParameterfv(sampler, gl::TEXTURE_BORDER_COLOR, [1.0f32; 4].as_ptr());
        if compare {
            gl::SamplerParameteri(
                sampler,
                gl::TEXTURE_COMPARE_MODE,
                gl::COMPARE_REF_TO_TEXTURE as i32,
            );
            gl::SamplerParameteri(sampler, gl::TEXTURE_COMPARE_FUNC, gl::LEQUAL as i32);
        }
    }
    sampler
}
fn noise_texture(size: i32) -> Texture {
    // Iris supplies linearly filtered, repeating white noise to the shader pack.
    let mut state = 0x1234abcd_u32;
    let mut pixels = Vec::with_capacity((size * size * 4) as usize);
    for _ in 0..(size * size) {
        for _ in 0..3 {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            pixels.push(state as u8);
        }
        pixels.push(255);
    }
    let texture = Texture::rgba(size, size, &pixels, true);
    unsafe {
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
    }
    texture
}
fn color_index(name: &str) -> Option<usize> {
    if let Some(n) = name.strip_prefix("colortex") {
        return n.parse().ok().filter(|n| *n < 16);
    }
    [
        "gcolor",
        "gdepth",
        "gnormal",
        "composite",
        "gaux1",
        "gaux2",
        "gaux3",
        "gaux4",
    ]
    .iter()
    .position(|n| *n == name)
}

fn image_slot(name:&str)->Option<usize> {
    name.strip_prefix("colorimg")?.parse().ok()
}
fn program_stage(program:&Program)->&str {
    let name=program.source.group.as_deref().unwrap_or(&program.source.name);
    if name.starts_with("gbuffers_")||name=="shadow" { return "gbuffers"; }
    if name=="final" { return "composite"; }
    name.trim_end_matches(|c:char| c.is_ascii_digit())
}

struct StorageBuffer {
    id:u32,
    bytes:usize,
}
impl Drop for StorageBuffer {
    fn drop(&mut self){unsafe{gl::DeleteBuffers(1,&self.id);}}
}

struct Buffers {
    width: i32,
    height: i32,
    colors: Vec<[Texture; 2]>,
    read: [usize; 16],
    depth: [Texture; 3],
    screen: Texture,
    custom: Vec<Texture>,
    storage:Vec<(u32,StorageBuffer)>,
}
impl Buffers {
    fn new(pack: &Pack, width: i32, height: i32, fb: &Framebuffer) -> Result<Self, String> {
        let color = |format| buffer_texture(width, height, format, false);
        let colors = pack
            .formats
            .iter()
            .map(|f| [color(*f), color(*f)])
            .collect();
        let mut custom=Vec::new();
        let mut image_bytes=0i64;
        for image in &pack.images {
            let dimension=|index:usize,base:i32| if image.relative {
                (image.size[index]*base as f32).ceil() as i32
            } else {image.size[index] as i32};
            let (w,h)=(dimension(0,width).max(1),dimension(1,height).max(1));
            image_bytes+=i64::from(w)*i64::from(h)*16;
            if w>4096||h>4096||image_bytes>128*1024*1024 {
                return Err(format!("自定义光影图像超出显存范围：{}",image.image));
            }
            let tex=buffer_texture(w,h,image_format(&image.format).unwrap(),false);
            Self::clear_color(fb,tex.0,[0.;4])?;
            custom.push(tex);
        }
        let mut storage=Vec::new();
        let mut total=0usize;
        for source in &pack.storage {
            let bytes=source.capacity(width,height).ok_or("光影存储缓冲大小溢出")?;
            total=total.checked_add(bytes).ok_or("光影存储缓冲大小溢出")?;
            if total>128*1024*1024{return Err("光影存储缓冲超出显存范围".into());}
            let seed=source.seed.as_ref().map(|data|STANDARD.decode(data).map_err(|_|"无效的存储缓冲初始数据")).transpose()?;
            if seed.as_ref().is_some_and(|s|s.len()>bytes){return Err("初始数据长于存储缓冲".into());}
            let mut buffer=StorageBuffer{id:0,bytes};
            unsafe{
                gl::GenBuffers(1,&mut buffer.id);
                gl::BindBuffer(gl::SHADER_STORAGE_BUFFER,buffer.id);
                gl::BufferData(gl::SHADER_STORAGE_BUFFER,bytes as isize,null(),gl::DYNAMIC_DRAW);
                gl::ClearBufferData(gl::SHADER_STORAGE_BUFFER,gl::R8UI,gl::RED_INTEGER,gl::UNSIGNED_BYTE,null());
                if let Some(seed)=seed {
                    gl::BufferSubData(gl::SHADER_STORAGE_BUFFER,0,seed.len() as isize,seed.as_ptr().cast());
                }
                gl::BindBuffer(gl::SHADER_STORAGE_BUFFER,0);
                let error=gl::GetError();
                if error!=gl::NO_ERROR{return Err(format!("光影存储缓冲分配失败，OpenGL 0x{error:x}"));}
            }
            storage.push((source.binding,buffer));
        }
        let buffers = Self {
            width,
            height,
            colors,
            read: [0; 16],
            depth: std::array::from_fn(|_| {
                buffer_texture(width, height, gl::DEPTH_COMPONENT24, true)
            }),
            screen: color(gl::RGBA8),
            custom,
            storage,
        };
        for pair in &buffers.colors {
            for tex in pair {
                Self::clear_color(fb, tex.0, [0.; 4])?;
            }
        }
        Ok(buffers)
    }
    fn clear_color(fb: &Framebuffer, tex: u32, color: [f32; 4]) -> Result<(), String> {
        fb.bind(&[Some(tex)], None)?;
        unsafe {
            gl::ClearBufferfv(gl::COLOR, 0, color.as_ptr());
        }
        Ok(())
    }
    fn clear_history(&mut self, pack: &Pack, fb: &Framebuffer) -> Result<(), String> {
        for &slot in &pack.persistent {
            self.read[slot] = 0;
            for tex in &self.colors[slot] {
                Self::clear_color(fb, tex.0, [0.; 4])?;
            }
        }
        Ok(())
    }
    fn clear(&mut self, pack: &Pack, fb: &Framebuffer, fog: [f32; 3]) -> Result<(), String> {
        for (index,image) in pack.images.iter().enumerate() {
            if image.clear { Self::clear_color(fb,self.custom[index].0,[0.;4])?; }
        }
        for slot in 0..self.colors.len() {
            if pack.persistent.contains(&slot) {
                continue;
            }
            self.read[slot] = 0;
            let color = match slot {
                0 => [fog[0], fog[1], fog[2], 1.],
                1 => [1.; 4],
                _ => [0.; 4],
            };
            Self::clear_color(fb, self.colors[slot][0].0, color)?;
        }
        fb.bind(&[], Some(self.depth[0].0))?;
        unsafe {
            gl::DepthMask(gl::TRUE);
            gl::ClearDepth(1.0);
            gl::Clear(gl::DEPTH_BUFFER_BIT);
        }
        Ok(())
    }
    fn read(&self, slot: usize) -> u32 {
        self.colors[slot][self.read[slot]].0
    }
    fn destination(&self, program: &Program, flip: bool) -> Result<Vec<Option<u32>>, String> {
        program
            .source
            .targets
            .iter()
            .map(|target| match target.as_deref() {
                None => Ok(None),
                Some("screen") => Ok(Some(self.screen.0)),
                Some(name) => {
                    let i = color_index(name).ok_or_else(|| format!("颜色附件无效：{name}"))?;
                    if i>=self.colors.len(){return Err(format!("颜色附件尚未分配：{name}"));}
                    Ok(Some(self.colors[i][self.read[i] ^ (flip as usize)].0))
                }
            })
            .collect()
    }
    fn flip(&mut self, targets: &[Option<String>]) {
        for target in targets.iter().flatten() {
            if let Some(i) = color_index(target) {
                self.read[i] ^= 1;
            }
        }
    }
}

struct Resources {
    pack: Pack,
    scene: Scene,
    noise: Texture,
    shadow_color: Texture,
    shadow_depth: [Texture; 2],
    neutral: Texture,
    textures: Vec<Texture>,
    buffers: Option<Buffers>,
    previous: Option<DrawFrame>,
    sequence: u64,
}
impl Resources {
    fn new(pack: Pack, scene: Scene) -> Result<Self,String> {
        let (shadow, noise) = (pack.shadow_size, pack.noise_size);
        let textures=pack.textures.iter().map(|entry|Texture::png(&entry.png)).collect::<Result<_,_>>()?;
        Ok(Self {
            pack,
            scene,
            noise: noise_texture(noise),
            shadow_color: buffer_texture(shadow, shadow, gl::RGBA8, false),
            shadow_depth: std::array::from_fn(|_| {
                buffer_texture(shadow, shadow, gl::DEPTH_COMPONENT24, true)
            }),
            neutral: Texture::rgba(1, 1, &[128, 128, 255, 255], false),
            textures,
            buffers: None,
            previous: None,
            sequence: 0,
        })
    }
}

fn matrices(modelview: &Matrix, projection: &Matrix) {
    unsafe {
        gl::MatrixMode(gl::PROJECTION);
        gl::LoadMatrixf(projection.as_ptr());
        gl::MatrixMode(gl::MODELVIEW);
        gl::LoadMatrixf(modelview.as_ptr());
    }
}
fn texture_matrices() {
    unsafe {
        gl::ActiveTexture(gl::TEXTURE0);
        gl::MatrixMode(gl::TEXTURE);
        gl::LoadIdentity();
        gl::ActiveTexture(gl::TEXTURE1);
        gl::MatrixMode(gl::TEXTURE);
        gl::LoadIdentity();
        // Minecraft's baked lightmap texel centers: (level * 16 + 8) / 256.
        gl::Translatef(8. / 256., 8. / 256., 0.);
        gl::Scalef(1. / 256., 1. / 256., 1.);
        gl::ActiveTexture(gl::TEXTURE0);
        gl::MatrixMode(gl::MODELVIEW);
    }
}
fn quad(points: [[f32; 3]; 4], uv: [[f32; 2]; 4]) {
    unsafe {
        gl::BindBuffer(gl::ARRAY_BUFFER, 0);
        gl::Color4f(1., 1., 1., 1.);
        gl::Begin(gl::QUADS);
        for (p, uv) in points.into_iter().zip(uv) {
            gl::MultiTexCoord2f(gl::TEXTURE0, uv[0], uv[1]);
            gl::Vertex3fv(p.as_ptr());
        }
        gl::End();
    }
}
fn fullscreen() {
    matrices(&IDENTITY, &IDENTITY);
    quad(
        [[-1., -1., 0.], [1., -1., 0.], [1., 1., 0.], [-1., 1., 0.]],
        [[0., 0.], [1., 0.], [1., 1.], [0., 1.]],
    );
}
fn celestial(direction: [f32; 3], size: f32, uv: [[f32; 2]; 4]) {
    let axis = if direction[1].abs() > 0.98 {
        [0., 0., 1.]
    } else {
        [0., 1., 0.]
    };
    let cross = |a: [f32; 3], b: [f32; 3]| {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let side = cross(direction, axis);
    let len = side.iter().map(|n| n * n).sum::<f32>().sqrt();
    let right = side.map(|v| v / len);
    let up = cross(right, direction);
    let point =
        |s, t| std::array::from_fn(|i| 100. * direction[i] + size * (s * right[i] + t * up[i]));
    quad(
        [
            point(-1., -1.),
            point(1., -1.),
            point(1., 1.),
            point(-1., 1.),
        ],
        uv,
    );
}

struct Render<'a> {
    assets: &'a Resources,
    buffer: &'a mut Buffers,
    framebuffer: &'a Framebuffer,
    scratch: &'a Framebuffer,
    shadow_compare: u32,
    shadow_raw: u32,
    frame: &'a DrawFrame,
    previous: &'a DrawFrame,
    sequence: u64,
    passes: Vec<String>,
}
impl Render<'_> {
    fn program(&self, name: &str) -> Result<&Program, String> {
        self.assets
            .pack
            .programs
            .get(name)
            .ok_or_else(|| format!("光影缺少阶段 {name}"))
    }
    fn bind_uniforms(&self, p: &Program, base_texture: u32) -> Result<(), String> {
        let f = self.frame;
        let old = self.previous;
        let time_angle=f.day_time as f32 / 24000.0;
        p.bind();
        for (binding,minimum) in &p.storage_blocks{
            let (_,buffer)=self.buffer.storage.iter()
                .find(|(candidate,buffer)|candidate==binding&&buffer.bytes>=*minimum)
                .ok_or_else(||format!("{} 的存储缓冲 {binding} 太小",p.source.name))?;
            unsafe{gl::BindBufferBase(gl::SHADER_STORAGE_BUFFER,*binding,buffer.id);}
        }
        if p.images.len()>8{return Err(format!("{} 图像绑定数超出限制",p.source.name));}
        for (unit,name) in p.images.iter().enumerate() {
            if !gl::BindImageTexture::is_loaded(){return Err("显卡无法绑定光影图像".into());}
            let (texture,format)=if let Some(slot)=image_slot(name) {
                let format=*self.assets.pack.formats.get(slot).ok_or_else(||format!("尚未分配的光影图像 {name}"))?;
                (self.buffer.read(slot),format)
            } else {
                let index=self.assets.pack.images.iter().position(|i|i.image==*name)
                    .ok_or_else(||format!("找不到光影图像 {name}"))?;
                (self.buffer.custom[index].0,image_format(&self.assets.pack.images[index].format).unwrap())
            };
            unsafe { gl::BindImageTexture(unit as u32,texture,0,gl::FALSE,0,gl::READ_WRITE,format); }
            p.int(name,unit as i32);
        }
        for (unit, (name, compare)) in p.samplers.iter().enumerate() {
            if unit >= 16 {
                return Err(format!("{} 的采样器数超出限制", p.source.name));
            }
            let mut sampler = 0;
            let stage=program_stage(p);
            let custom=self.assets.pack.textures.iter().position(|t|t.sampler==*name&&t.stage.as_deref()==Some(stage))
                .or_else(||self.assets.pack.textures.iter().position(|t|t.sampler==*name&&t.stage.is_none()));
            let image=self.assets.pack.images.iter().position(|t|t.sampler==*name);
            let tex = if let Some(index)=custom { self.assets.textures[index].0 }
            else if let Some(index)=image { self.buffer.custom[index].0 }
            else if let Some(slot) = color_index(name) {
                self.buffer.read(slot)
            } else {
                match name.as_str() {
                    "texture" | "gtexture" | "tex" => base_texture,
                    "normals" | "specular" | "lightmap" => self.assets.neutral.0,
                    "noisetex" => self.assets.noise.0,
                    "depthtex0" | "gdepthtex" => self.buffer.depth[0].0,
                    "depthtex1" => self.buffer.depth[1].0,
                    "depthtex2" => self.buffer.depth[2].0,
                    "shadowcolor" | "shadowcolor0" => self.assets.shadow_color.0,
                    "shadowtex0" | "shadow" | "watershadow" | "shadowtex1" => {
                        sampler = if *compare {
                            self.shadow_compare
                        } else {
                            self.shadow_raw
                        };
                        self.assets.shadow_depth[usize::from(name == "shadowtex1")].0
                    }
                    _ => return Err(format!("{} 使用尚未接入的纹理 {name}", p.source.name)),
                }
            };
            unsafe {
                gl::ActiveTexture(gl::TEXTURE0 + unit as u32);
                gl::BindTexture(gl::TEXTURE_2D, tex);
                gl::BindSampler(unit as u32, sampler);
            }
            p.int(name, unit as i32);
        }
        for (name, value) in [
            ("near", f.near),
            ("far", f.far),
            ("viewWidth", f.width as f32),
            ("viewHeight", f.height as f32),
            ("aspectRatio", f.width as f32 / f.height as f32),
            ("rainStrength", f.rain),
            ("timeAngle", time_angle),
            ("timeBrightness", (time_angle * std::f32::consts::TAU).sin().max(0.0)),
            ("wetness", f.rain),
            ("frameTimeCounter", f.time_counter % 3600.0),
            ("BiomeTemp", f.biome_temp),
            ("inSwamp", f.in_swamp),
            ("isSwamp", f.in_swamp),
            ("alphaTestRef", p.source.alpha_test),
            ("sunElevation", f.sun_world[1]),
            ("nightVision", 0.),
            ("blindness", 0.),
            ("darknessFactor", 0.),
            ("darknessLightFactor", 0.),
        ] {
            p.float(name, value);
        }
        for (name, value) in [
            ("worldTime", f.day_time),
            ("isEyeInWater", f.eye_in_water),
            ("heldBlockLightValue", 0),
            ("heldBlockLightValue2", 0),
            ("entityId", 0),
            ("framemod8", (self.sequence % 8) as i32),
            ("framemod2", (self.sequence % 2) as i32),
            ("frameCounter", self.sequence as i32),
        ] {
            p.int(name, value);
        }
        let brightness = self.assets.scene.eye_light(f.camera);
        p.ivec2("eyeBrightness", brightness);
        p.ivec2("eyeBrightnessSmooth", brightness);
        for (name, value) in [
            ("sunPosition", f.sun),
            ("upPosition", f.up),
            ("shadowLightPosition", f.shadow_light),
            ("cameraPosition", f.camera),
            ("previousCameraPosition", old.camera),
            ("fogColor", f.fog_color),
        ] {
            p.vec3(name, value);
        }
        p.vec4("entityColor", [0.; 4]);
        for (name, matrix) in [
            ("gbufferModelView", &f.rotation),
            ("gbufferModelViewInverse", &f.inverse_rotation),
            ("gbufferProjection", &f.projection),
            ("gbufferProjectionInverse", &f.inverse_projection),
            ("gbufferPreviousProjection", &old.projection),
            ("gbufferPreviousModelView", &old.rotation),
            ("shadowModelView", &f.shadow_rotation),
            ("shadowProjection", &f.shadow_projection),
        ] {
            p.matrix(name, matrix);
        }
        Ok(())
    }
    fn check(&mut self, name: &str) -> Result<(), String> {
        let p=self.program(name)?;
        if !p.storage_blocks.is_empty()||!p.images.is_empty(){
            unsafe {gl::MemoryBarrier(gl::ALL_BARRIER_BITS);}
        }
        let error = unsafe { gl::GetError() };
        if error != gl::NO_ERROR {
            return Err(format!("{name} 执行失败，OpenGL 0x{error:x}"));
        }
        self.passes.push(name.to_string());
        Ok(())
    }
    fn shadow(&mut self) -> Result<(), String> {
        let size = self.assets.pack.shadow_size;
        self.framebuffer.bind(
            &[Some(self.assets.shadow_color.0)],
            Some(self.assets.shadow_depth[0].0),
        )?;
        unsafe {
            gl::Viewport(0, 0, size, size);
            gl::Enable(gl::DEPTH_TEST);
            gl::DepthMask(gl::TRUE);
            gl::Disable(gl::BLEND);
            gl::Disable(gl::ALPHA_TEST);
            gl::ClearColor(1., 1., 1., 1.);
            gl::ClearDepth(1.);
            gl::Clear(gl::COLOR_BUFFER_BIT | gl::DEPTH_BUFFER_BIT);
        }
        let p = self.program("shadow")?;
        self.bind_uniforms(p, self.assets.scene.atlas.0)?;
        matrices(&self.frame.shadow_view, &self.frame.shadow_projection);
        unsafe {
            gl::Enable(gl::ALPHA_TEST);
            gl::AlphaFunc(gl::GREATER, 0.1);
        }
        self.assets.scene.draw("gbuffers_terrain", p);
        self.assets.scene.draw("gbuffers_block", p);
        self.framebuffer
            .copy_depth_to(self.scratch, self.assets.shadow_depth[1].0, size, size)?;
        if self.assets.pack.shadow_translucent {
            self.assets.scene.draw("gbuffers_water", p);
        }
        unsafe {
            gl::Disable(gl::ALPHA_TEST);
        }
        self.check("shadow")
    }
    fn sky(&mut self) -> Result<(), String> {
        let f = self.frame;
        unsafe {
            gl::Viewport(0, 0, f.width, f.height);
            gl::DepthMask(gl::FALSE);
            gl::Disable(gl::DEPTH_TEST);
            gl::Disable(gl::BLEND);
            gl::Disable(gl::ALPHA_TEST);
        }
        let basic = self.program("gbuffers_skybasic")?;
        self.framebuffer.bind(
            &self.buffer.destination(basic, false)?,
            Some(self.buffer.depth[0].0),
        )?;
        self.bind_uniforms(basic, self.assets.scene.atlas.0)?;
        basic.int("renderStage", 1);
        fullscreen();
        self.check("gbuffers_skybasic")?;
        let sky = self.program("gbuffers_skytextured")?;
        self.framebuffer.bind(
            &self.buffer.destination(sky, false)?,
            Some(self.buffer.depth[0].0),
        )?;
        unsafe {
            gl::Enable(gl::ALPHA_TEST);
            gl::AlphaFunc(gl::GREATER, 0.0);
            gl::Enable(gl::BLEND);
            // Vanilla's celestial sprites have a black RGB background, including in opaque PNGs.
            gl::BlendFuncSeparate(gl::SRC_ALPHA, gl::ONE, gl::ZERO, gl::ONE);
        }
        matrices(&f.rotation, &f.projection);
        self.bind_uniforms(sky, self.assets.scene.sun.0)?;
        sky.int("renderStage", 4);
        celestial(f.sun_world, 30., [[0., 0.], [1., 0.], [1., 1.], [0., 1.]]);
        let x = (f.moon_phase % 4) as f32 * 0.25;
        let y = 1. - (f.moon_phase / 4) as f32 * 0.5;
        self.bind_uniforms(sky, self.assets.scene.moon.0)?;
        sky.int("renderStage", 5);
        celestial(
            f.sun_world.map(|n| -n),
            20.,
            [[x, y - 0.5], [x + 0.25, y - 0.5], [x + 0.25, y], [x, y]],
        );
        unsafe {
            gl::Disable(gl::ALPHA_TEST);
            gl::Disable(gl::BLEND);
        }
        self.check("gbuffers_skytextured")
    }
    fn geometry(&mut self, name: &str) -> Result<(), String> {
        let p = self.program(name)?;
        self.framebuffer.bind(
            &self.buffer.destination(p, false)?,
            Some(self.buffer.depth[0].0),
        )?;
        self.bind_uniforms(p, self.assets.scene.atlas.0)?;
        p.int("renderStage", match name { "gbuffers_block"=>12, "gbuffers_water"=>17, _=>8 });
        matrices(&self.frame.view, &self.frame.projection);
        unsafe {
            gl::Enable(gl::DEPTH_TEST);
            gl::DepthFunc(gl::LEQUAL);
            gl::DepthMask(gl::TRUE);
            if p.source.blend {
                gl::Enable(gl::BLEND);
                gl::BlendFuncSeparate(
                    gl::SRC_ALPHA,
                    gl::ONE_MINUS_SRC_ALPHA,
                    gl::ONE,
                    gl::ONE_MINUS_SRC_ALPHA,
                );
            } else {
                gl::Disable(gl::BLEND);
            }
            if p.source.alpha_test > 0. {
                gl::Enable(gl::ALPHA_TEST);
                gl::AlphaFunc(gl::GREATER, p.source.alpha_test);
            } else {
                gl::Disable(gl::ALPHA_TEST);
            }
        }
        self.assets.scene.draw(name, p);
        self.check(name)
    }
    fn composite(&mut self, name: &str) -> Result<(), String> {
        let p = self.program(name)?;
        self.framebuffer
            .bind(&self.buffer.destination(p, true)?, None)?;
        unsafe {
            gl::Disable(gl::DEPTH_TEST);
            gl::DepthMask(gl::FALSE);
            gl::Disable(gl::BLEND);
            gl::Disable(gl::ALPHA_TEST);
            for i in &p.source.mipmaps {
                gl::ActiveTexture(gl::TEXTURE0);
                gl::BindTexture(gl::TEXTURE_2D, self.buffer.read(*i));
                gl::GenerateMipmap(gl::TEXTURE_2D);
                gl::TexParameteri(
                    gl::TEXTURE_2D,
                    gl::TEXTURE_MIN_FILTER,
                    gl::LINEAR_MIPMAP_LINEAR as i32,
                );
            }
        }
        self.bind_uniforms(p, self.assets.scene.atlas.0)?;
        fullscreen();
        let targets = p.source.targets.clone();
        self.buffer.flip(&targets);
        self.check(name)
    }
    fn dispatch_compute(&mut self, name:&str) -> Result<(),String> {
        let p=self.program(name)?;
        let local=p.local_size.ok_or("光影计算阶段缺少工作组尺寸")?;
        if local.iter().any(|n| *n<=0) { return Err("光影计算阶段工作组尺寸无效".into()); }
        self.bind_uniforms(p,self.assets.scene.atlas.0)?;
        let relative=p.source.relative.unwrap_or([1.,1.]);
        let group=p.source.groups.unwrap_or_else(||[
            (self.frame.width as f32*relative[0]/local[0] as f32).ceil() as u32,
            (self.frame.height as f32*relative[1]/local[1] as f32).ceil() as u32,1]);
        let invocations=group.iter().fold(1u64,|acc,&n|acc.saturating_mul(u64::from(n)))
            .saturating_mul(local.iter().map(|&n|n as u64).product());
        if group.iter().any(|&n|n==0||n>65535)||invocations>268_435_456 {
            return Err(format!("{} 的计算工作组超出渲染范围",p.source.name));
        }
        unsafe {
            gl::DispatchCompute(group[0],group[1],group[2]);
            gl::MemoryBarrier(gl::ALL_BARRIER_BITS);
        }
        self.check(name)
    }
    fn run_group(&mut self,name:&str)->Result<(),String>{
        let mut compute=self.assets.pack.programs.iter()
            .filter(|(_,p)|p.source.group.as_deref()==Some(name))
            .map(|(key,_)|key.clone()).collect::<Vec<_>>();
        compute.sort_unstable();
        for kernel in compute {self.dispatch_compute(&kernel)?;}
        if self.assets.pack.programs.contains_key(name){self.composite(name)?;}
        Ok(())
    }
    fn fullscreen_passes(&mut self, prefix: &str) -> Result<(), String> {
        let mut passes = self.assets.pack.programs.values().filter_map(|program| {
            let name=program.source.group.as_ref().unwrap_or(&program.source.name);
            let suffix = name.strip_prefix(prefix)?;
            let order = if suffix.is_empty() { 0 } else { suffix.parse::<u32>().ok()? };
            Some((order, name.clone()))
        }).collect::<Vec<_>>();
        passes.sort_unstable();
        passes.dedup();
        for (_, name) in passes {
            self.run_group(&name)?;
        }
        Ok(())
    }
    fn run(&mut self, render_shadow: bool, setup:bool) -> Result<(), String> {
        let f = self.frame;
        unsafe {
            gl::Disable(gl::CULL_FACE);
            gl::Disable(gl::FRAMEBUFFER_SRGB);
            gl::Disable(gl::SCISSOR_TEST);
        }
        texture_matrices();
        self.buffer
            .clear(&self.assets.pack, self.framebuffer, f.fog_color)?;
        if setup {self.fullscreen_passes("setup")?;}
        self.fullscreen_passes("begin")?;
        if render_shadow {
            self.shadow()?;
        }
        self.fullscreen_passes("prepare")?;
        self.sky()?;
        self.geometry("gbuffers_terrain")?;
        if self.assets.pack.programs.contains_key("gbuffers_block") {
            self.geometry("gbuffers_block")?;
        }
        self.framebuffer
            .copy_depth_to(self.scratch, self.buffer.depth[1].0, f.width, f.height)?;
        self.framebuffer
            .copy_depth_to(self.scratch, self.buffer.depth[2].0, f.width, f.height)?;
        self.fullscreen_passes("deferred")?;
        self.geometry("gbuffers_water")?;
        self.framebuffer
            .copy_depth_to(self.scratch, self.buffer.depth[2].0, f.width, f.height)?;
        self.fullscreen_passes("composite")?;
        self.run_group("final")
    }
    fn read_final(&self) -> Result<Vec<u8>, String> {
        let f = self.frame;
        let stride = f.width as usize * 4;
        let mut rgba = vec![0u8; stride * f.height as usize];
        unsafe {
            gl::PixelStorei(gl::PACK_ALIGNMENT, 1);
            gl::ReadPixels(
                0,
                0,
                f.width,
                f.height,
                gl::RGBA,
                gl::UNSIGNED_BYTE,
                rgba.as_mut_ptr().cast(),
            );
            gl::UseProgram(0);
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
        }
        let code = unsafe { gl::GetError() };
        if code != gl::NO_ERROR {
            return Err(format!("光影读取像素失败：0x{code:x}"));
        }
        for y in 0..(f.height as usize / 2) {
            let (first, last) = rgba.split_at_mut((f.height as usize - 1 - y) * stride);
            first[y * stride..(y + 1) * stride].swap_with_slice(&mut last[..stride]);
        }
        Ok(rgba)
    }
}

pub struct Engine {
    // Context is dropped after all GL-owned resources.
    resources: Option<Resources>,
    checked: Option<Pack>,
    framebuffer: Framebuffer,
    scratch: Framebuffer,
    compare: u32,
    raw: u32,
    report: Value,
    _context: Context,
}
impl Engine {
    pub fn new() -> Result<Self, String> {
        let context = Context::new()?;
        Ok(Self {
            resources: None,
            checked: None,
            framebuffer: Framebuffer::new(),
            scratch: Framebuffer::new(),
            compare: depth_sampler(true),
            raw: depth_sampler(false),
            report: json!(null),
            _context: context,
        })
    }
    pub fn check(&mut self, source: PackSources) -> Result<Value, String> {
        let pack = Pack::compile(source)?;
        for (name, program) in &pack.programs {
            if !matches!(name.as_str(),"shadow"|"gbuffers_skybasic"|"gbuffers_skytextured"|"gbuffers_terrain"|"gbuffers_block"|"gbuffers_water"|"final")
                && program.local_size.is_none()
                && !["begin","prepare","deferred","composite"].iter().any(|prefix|name.starts_with(prefix)){continue;}
            if program.samplers.len()>16{return Err(format!("{name} 的采样器数超出限制"));}
            for (sampler,_) in &program.samplers{
                if pack.textures.iter().any(|t|t.sampler==*sampler&&(t.stage.is_none()||t.stage.as_deref()==Some(program_stage(program))))
                    ||pack.images.iter().any(|i|i.sampler==*sampler){continue;}
                if color_index(sampler).is_some_and(|slot|slot>=pack.formats.len()){
                    return Err(format!("{name} 引用了未分配的颜色缓冲 {sampler}"));
                }
                if color_index(sampler).is_none()&&!matches!(sampler.as_str(),"texture"|"gtexture"|"tex"|"normals"|"specular"|"lightmap"|"noisetex"|"depthtex0"|"gdepthtex"|"depthtex1"|"depthtex2"|"shadowcolor"|"shadowcolor0"|"shadowtex0"|"shadowtex1"|"shadow"|"watershadow"){
                    return Err(format!("{name} 使用尚未接入的纹理 {sampler}"));
                }
            }
        }
        let count=pack.programs.len();
        self.checked=Some(pack);
        Ok(json!({"compiled_programs":count,"driver":driver()}))
    }
    pub fn prepare(&mut self, pack: PackSources, scene: SceneSource) -> Result<Value, String> {
        let scene = Scene::upload(scene)?;
        if let Some(active)=self.resources.as_mut().filter(|r|r.pack.hash==pack.hash){
            active.scene=scene;
            active.previous=None;
            active.buffers=None;
            active.sequence=0;
            return Ok(json!({"compiled_programs":active.pack.programs.len(),"driver":driver(),"reused":true}));
        }
        if self.checked.as_ref().is_none_or(|p|p.hash!=pack.hash){self.check(pack)?;}
        let compiled=self.checked.take().unwrap();
        let count = compiled.programs.len();
        self.resources = Some(Resources::new(compiled, scene)?);
        Ok(json!({"compiled_programs":count,"driver":driver()}))
    }
    pub fn draw(&mut self, mut frame: DrawFrame) -> Result<Vec<u8>, String> {
        frame.validate()?;
        let state = self.resources.as_mut().ok_or("尚未打开离线光影场景")?;
        if let Some(atlas) = frame.atlas_update.take() {
            state.scene.atlas = Texture::png(&atlas)?;
        }
        let new_buffers=state
            .buffers
            .as_ref()
            .is_none_or(|b| b.width != frame.width || b.height != frame.height);
        if new_buffers {
            state.buffers = Some(Buffers::new(
                &state.pack,
                frame.width,
                frame.height,
                &self.framebuffer,
            )?);
            state.previous = None;
        }
        let mut buffer = state.buffers.take().unwrap();
        let reset = frame.reset_history
            || state
                .previous
                .as_ref()
                .is_none_or(|old| !frame.follows(old));
        let sequence = if reset { 0 } else { state.sequence };
        let mut rendering = Render {
            assets: state,
            buffer: &mut buffer,
            framebuffer: &self.framebuffer,
            scratch: &self.scratch,
            shadow_compare: self.compare,
            shadow_raw: self.raw,
            frame: &frame,
            previous: state.previous.as_ref().filter(|_| !reset).unwrap_or(&frame),
            sequence,
            passes: Vec::new(),
        };
        let mut passes = Vec::new();
        let result = (|| {
            if reset {
                rendering
                    .buffer
                    .clear_history(&state.pack, &self.framebuffer)?;
            }
            for sample in 0..frame.samples {
                rendering.run(sample == 0,new_buffers&&sample==0)?;
                if sample == 0 {
                    passes = std::mem::take(&mut rendering.passes);
                } else {
                    rendering.passes.clear();
                }
                rendering.previous = &frame;
                rendering.sequence += 1;
            }
            rendering.read_final()
        })();
        drop(rendering);
        state.buffers = Some(buffer);
        if result.is_ok() {
            state.sequence = sequence + u64::from(frame.samples);
            self.report = json!({"archive":state.pack.name,"archive_sha256":state.pack.archive_sha256,"render_profile_sha256":state.pack.hash,"driver":driver(),
              "compiled_programs":state.pack.programs.len(),"stages":passes,"vertices":state.scene.vertices,
              "frame":state.sequence,"temporal_samples":frame.samples,"history_reset":reset,
              "shader_time":frame.time_counter,"width":frame.width,"height":frame.height});
            state.previous = Some(frame);
        } else {
            state.previous = None;
        }
        result
    }
    pub fn report(&self) -> Value {
        self.report.clone()
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            gl::DeleteSamplers(1, &self.compare);
            gl::DeleteSamplers(1, &self.raw);
        }
    }
}
