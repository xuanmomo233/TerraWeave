use crate::{
    iris_context::{gl, Context},
    iris_mesh::{Scene, SceneSource, Texture},
    iris_pack::{driver, Pack, PackSources, Program},
};
use serde::Deserialize;
use serde_json::{json, Value};
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
        return n.parse().ok().filter(|n| *n < 8);
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

struct Buffers {
    width: i32,
    height: i32,
    colors: Vec<[Texture; 2]>,
    read: [usize; 8],
    depth: [Texture; 3],
    screen: Texture,
}
impl Buffers {
    fn new(pack: &Pack, width: i32, height: i32, fb: &Framebuffer) -> Result<Self, String> {
        let color = |format| buffer_texture(width, height, format, false);
        let colors = pack
            .formats
            .iter()
            .map(|f| [color(*f), color(*f)])
            .collect();
        let buffers = Self {
            width,
            height,
            colors,
            read: [0; 8],
            depth: std::array::from_fn(|_| {
                buffer_texture(width, height, gl::DEPTH_COMPONENT24, true)
            }),
            screen: color(gl::RGBA8),
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
        for slot in 0..8 {
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
    buffers: Option<Buffers>,
    previous: Option<DrawFrame>,
    sequence: u64,
}
impl Resources {
    fn new(pack: Pack, scene: Scene) -> Self {
        let (shadow, noise) = (pack.shadow_size, pack.noise_size);
        Self {
            pack,
            scene,
            noise: noise_texture(noise),
            shadow_color: buffer_texture(shadow, shadow, gl::RGBA8, false),
            shadow_depth: std::array::from_fn(|_| {
                buffer_texture(shadow, shadow, gl::DEPTH_COMPONENT24, true)
            }),
            neutral: Texture::rgba(1, 1, &[128, 128, 255, 255], false),
            buffers: None,
            previous: None,
            sequence: 0,
        }
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
        p.bind();
        for (unit, (name, compare)) in p.samplers.iter().enumerate() {
            if unit >= 16 {
                return Err(format!("{} 的采样器数超出限制", p.source.name));
            }
            let mut sampler = 0;
            let tex = if let Some(slot) = color_index(name) {
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
            ("wetness", f.rain),
            ("frameTimeCounter", f.time_counter % 3600.0),
            ("BiomeTemp", f.biome_temp),
            ("inSwamp", f.in_swamp),
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
        fullscreen();
        self.check("gbuffers_skybasic")?;
        let sky = self.program("gbuffers_skytextured")?;
        self.framebuffer.bind(
            &self.buffer.destination(sky, false)?,
            Some(self.buffer.depth[0].0),
        )?;
        matrices(&f.rotation, &f.projection);
        self.bind_uniforms(sky, self.assets.scene.sun.0)?;
        celestial(f.sun_world, 30., [[0., 0.], [1., 0.], [1., 1.], [0., 1.]]);
        let x = (f.moon_phase % 4) as f32 * 0.25;
        let y = 1. - (f.moon_phase / 4) as f32 * 0.5;
        self.bind_uniforms(sky, self.assets.scene.moon.0)?;
        celestial(
            f.sun_world.map(|n| -n),
            20.,
            [[x, y - 0.5], [x + 0.25, y - 0.5], [x + 0.25, y], [x, y]],
        );
        self.check("gbuffers_skytextured")
    }
    fn geometry(&mut self, name: &str) -> Result<(), String> {
        let p = self.program(name)?;
        self.framebuffer.bind(
            &self.buffer.destination(p, false)?,
            Some(self.buffer.depth[0].0),
        )?;
        self.bind_uniforms(p, self.assets.scene.atlas.0)?;
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
    fn run(&mut self, render_shadow: bool) -> Result<(), String> {
        let f = self.frame;
        unsafe {
            gl::Disable(gl::CULL_FACE);
            gl::Disable(gl::FRAMEBUFFER_SRGB);
            gl::Disable(gl::SCISSOR_TEST);
        }
        texture_matrices();
        if render_shadow {
            self.shadow()?;
        }
        self.buffer
            .clear(&self.assets.pack, self.framebuffer, f.fog_color)?;
        self.sky()?;
        self.geometry("gbuffers_terrain")?;
        if self.assets.pack.programs.contains_key("gbuffers_block") {
            self.geometry("gbuffers_block")?;
        }
        self.framebuffer
            .copy_depth_to(self.scratch, self.buffer.depth[1].0, f.width, f.height)?;
        self.geometry("gbuffers_water")?;
        self.framebuffer
            .copy_depth_to(self.scratch, self.buffer.depth[2].0, f.width, f.height)?;
        let mut composites = self
            .assets
            .pack
            .programs
            .keys()
            .filter_map(|name| {
                let suffix = name.strip_prefix("composite")?;
                let order = if suffix.is_empty() {
                    0
                } else {
                    suffix.parse::<u32>().ok()?
                };
                Some((order, name.clone()))
            })
            .collect::<Vec<_>>();
        composites.sort_unstable_by_key(|(i, _)| *i);
        for (_, name) in composites {
            self.composite(&name)?;
        }
        self.composite("final")
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
                && !name.starts_with("composite"){continue;}
            if program.samplers.len()>16{return Err(format!("{name} 的采样器数超出限制"));}
            for (sampler,_) in &program.samplers{
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
        self.resources = Some(Resources::new(compiled, scene));
        Ok(json!({"compiled_programs":count,"driver":driver()}))
    }
    pub fn draw(&mut self, frame: DrawFrame) -> Result<Vec<u8>, String> {
        frame.validate()?;
        let state = self.resources.as_mut().ok_or("尚未打开离线光影场景")?;
        if state
            .buffers
            .as_ref()
            .is_none_or(|b| b.width != frame.width || b.height != frame.height)
        {
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
                rendering.run(sample == 0)?;
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
            self.report = json!({"archive":state.pack.name,"archive_sha256":state.pack.hash,"driver":driver(),
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
