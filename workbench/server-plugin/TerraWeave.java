import org.bukkit.*;
import org.bukkit.block.Block;
import org.bukkit.block.BlockState;
import org.bukkit.block.Sign;
import org.bukkit.block.TileState;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.sign.Side;
import org.bukkit.block.sign.SignSide;
import org.bukkit.plugin.java.JavaPlugin;
import com.google.gson.*;
import net.kyori.adventure.text.serializer.gson.GsonComponentSerializer;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.util.*;

public final class TerraWeave extends JavaPlugin {
    private final Gson gson = new GsonBuilder().serializeNulls().create();
    private Path root, requests, responses, receipts, intents;
    private World world;
    private PaperBlockEntityCodec entityCodec;
    public void onEnable() {
        try {
            root = getDataFolder().toPath();
            requests = root.resolve("requests"); responses = root.resolve("responses");
            receipts = root.resolve("receipts"); intents = root.resolve("intents");
            Files.createDirectories(requests); Files.createDirectories(responses);
            Files.createDirectories(receipts); Files.createDirectories(intents);
            String name = getServer().getWorlds().get(0).getName();
            world = Bukkit.getWorld(name);
            try { entityCodec = PaperBlockEntityCodec.detect(); }
            catch (ReflectiveOperationException unavailable) {
                getLogger().warning("Exact block entity restore is unavailable: " + unavailable);
            }
            getServer().getScheduler().runTaskTimer(this, this::poll, 1L, 2L);
            getServer().getScheduler().runTaskTimer(this, this::heartbeat, 1L, 20L);
            getLogger().info("Persistent map workbench ready: " + world.getName());
        } catch (Exception e) { throw new RuntimeException(e); }
    }
    public void onDisable() {
        try { Files.deleteIfExists(root.resolve("heartbeat.json")); } catch (Exception ignored) {}
    }
    private void atomic(Path target, Object value) throws Exception {
        Path pending = target.resolveSibling(target.getFileName() + ".pending");
        Files.writeString(pending, gson.toJson(value), StandardCharsets.UTF_8);
        try (FileChannel file = FileChannel.open(pending, StandardOpenOption.WRITE)) { file.force(true); }
        Files.move(pending, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }
    private JsonObject identity() {
        JsonObject r = new JsonObject();
        r.addProperty("pid", ProcessHandle.current().pid()); r.addProperty("world", world.getName());
        r.addProperty("world_uuid", world.getUID().toString()); r.addProperty("minecraft", Bukkit.getMinecraftVersion());
        r.addProperty("data_version", Bukkit.getUnsafe().getDataVersion());
        r.addProperty("sign_payload", 1);
        r.addProperty("block_entity_payload", entityCodec == null ? 0 : 1);
        r.addProperty("at_ms", System.currentTimeMillis()); r.addProperty("server_root", getServer().getWorldContainer().getAbsolutePath());
        return r;
    }
    private void heartbeat() { try { atomic(root.resolve("heartbeat.json"), identity()); } catch (Exception e) { getLogger().warning(e.toString()); } }
    private int[] bounds(JsonElement value) {
        if (value == null || !value.isJsonArray() || value.getAsJsonArray().size() != 6) throw new IllegalArgumentException("Six integer bounds required");
        int[] b = new int[6];
        for (int i=0;i<6;i++) { double n=value.getAsJsonArray().get(i).getAsDouble(); if (!Double.isFinite(n)||n!=Math.rint(n)||Math.abs(n)>30000000) throw new IllegalArgumentException("Invalid coordinate"); b[i]=(int)n; }
        long volume=1;
        for (int i=0;i<3;i++) { if (b[i]>b[i+3]) throw new IllegalArgumentException("Reversed bounds"); volume=Math.multiplyExact(volume,(long)b[i+3]-b[i]+1); }
        if (b[1]<world.getMinHeight()||b[4]>=world.getMaxHeight()||volume>147456) throw new IllegalArgumentException("Region exceeds world height or 147456 positions");
        return b;
    }
    private JsonObject snapshot(int[] b) {return snapshot(b,false);}
    private JsonObject snapshot(int[] b,boolean generatedOnly) {
        JsonObject r=identity(), blocks=new JsonObject(); JsonArray blockEntities=new JsonArray();
        Set<String> unknown=new HashSet<>(),checked=new HashSet<>();
        if(generatedOnly)for(int z=Math.floorDiv(b[2],16);z<=Math.floorDiv(b[5],16);z++)for(int x=Math.floorDiv(b[0],16);x<=Math.floorDiv(b[3],16);x++)if(!world.isChunkGenerated(x,z))unknown.add(x+","+z);
        r.addProperty("schema",1); r.addProperty("uuid",world.getUID().toString()); r.add("bounds",gson.toJsonTree(b));
        for(int y=b[1];y<=b[4];y++) for(int z=b[2];z<=b[5];z++) for(int x=b[0];x<=b[3];x++) {
            if(unknown.contains(Math.floorDiv(x,16)+","+Math.floorDiv(z,16)))continue;
            Block block=world.getBlockAt(x,y,z); blocks.addProperty(x+","+y+","+z,block.getBlockData().getAsString());
            if(block.getState() instanceof TileState)blockEntities.add(gson.toJsonTree(new int[]{x,y,z}));
        }
        r.add("blocks",blocks); r.addProperty("block_entity_count",blockEntities.size());r.add("block_entity_positions",blockEntities);r.add("unknown_chunks",gson.toJsonTree(unknown));
        r.addProperty("source","live_paper_main_thread"); return r;
    }
    private record Edit(int x,int y,int z,BlockData data,String before,JsonElement beforeEntity,JsonElement afterEntity) {}

    private static JsonElement signPayload(BlockState state) throws IOException {
        if (!(state instanceof Sign sign)) return JsonNull.INSTANCE;
        JsonObject payload = new JsonObject();
        payload.addProperty("waxed", sign.isWaxed());
        for (Side side : Side.values()) {
            SignSide surface = sign.getSide(side);
            JsonObject data = new JsonObject();
            JsonArray lines = new JsonArray();
            for (int i=0;i<4;i++) lines.add(GsonComponentSerializer.gson().serialize(surface.line(i)));
            data.add("lines", lines);
            data.addProperty("color", surface.getColor().name());
            data.addProperty("glowing", surface.isGlowingText());
            payload.add(side.name(), data);
        }
        var persistent = sign.getPersistentDataContainer();
        if (!persistent.isEmpty()) payload.addProperty("persistent", Base64.getEncoder().encodeToString(persistent.serializeToBytes()));
        return payload;
    }

    private static void restoreSign(BlockState state, JsonElement payload) throws IOException {
        if (payload.isJsonNull()) return;
        if (!(state instanceof Sign sign)) throw new IllegalArgumentException("Sign payload requires a sign block");
        JsonObject data = payload.getAsJsonObject();
        sign.setWaxed(data.get("waxed").getAsBoolean());
        for (Side side : Side.values()) {
            JsonObject surface = data.getAsJsonObject(side.name());
            JsonArray lines = surface.getAsJsonArray("lines");
            if (lines.size() != 4) throw new IllegalArgumentException("Expected four sign lines");
            SignSide target = sign.getSide(side);
            for (int i=0;i<4;i++) target.line(i, GsonComponentSerializer.gson().deserialize(lines.get(i).getAsString()));
            target.setColor(DyeColor.valueOf(surface.get("color").getAsString()));
            target.setGlowingText(surface.get("glowing").getAsBoolean());
        }
        var persistent = sign.getPersistentDataContainer();
        for (NamespacedKey key : persistent.getKeys()) persistent.remove(key);
        if (data.has("persistent")) persistent.readFromBytes(Base64.getDecoder().decode(data.get("persistent").getAsString()));
    }
    private boolean reversibleEntity(BlockState state) {
        return state instanceof Sign || entityCodec != null && entityCodec.supports(state);
    }
    private JsonElement captureEntity(BlockState state) throws Exception {
        if (state instanceof Sign) return signPayload(state);
        return entityCodec != null ? entityCodec.capture(state) : JsonNull.INSTANCE;
    }
    private static boolean nativePayload(JsonElement payload) {
        return payload != null && payload.isJsonObject() && payload.getAsJsonObject().has("codec");
    }
    private boolean sameEntity(JsonElement actual, JsonElement expected) throws Exception {
        if (actual.equals(expected)) return true;
        return entityCodec != null && nativePayload(actual) && nativePayload(expected)
            && entityCodec.equivalent(actual,expected);
    }
    private void restoreEntity(BlockState state, JsonElement payload) throws Exception {
        if (nativePayload(payload)) {
            if (entityCodec == null) throw new IllegalArgumentException("Exact block entity codec unavailable");
            entityCodec.restore(state,payload);
        } else restoreSign(state,payload);
    }
    private static JsonElement entityField(JsonObject data, String phase) {
        return data.has(phase+"_entity") ? data.get(phase+"_entity") : data.get(phase+"_sign");
    }
    private JsonObject execute(JsonObject q, String id, String digest) throws Exception {
        String action=q.get("action").getAsString();
        if(action.equals("status"))return identity();
        if(action.equals("surface_samples")){
            JsonArray positions=q.getAsJsonArray("positions"),samples=new JsonArray();if(positions==null||positions.size()>512)throw new IllegalArgumentException("Maximum 512 surface points");
            for(JsonElement e:positions){JsonArray p=e.getAsJsonArray();int x=p.get(0).getAsInt(),z=p.get(1).getAsInt();JsonObject s=new JsonObject();s.addProperty("x",x);s.addProperty("z",z);if(world.isChunkGenerated(Math.floorDiv(x,16),Math.floorDiv(z,16))){int y=world.getHighestBlockYAt(x,z,HeightMap.WORLD_SURFACE);s.addProperty("y",y);s.addProperty("state",y<world.getMinHeight()?"minecraft:air":world.getBlockAt(x,y,z).getBlockData().getAsString());}samples.add(s);}JsonObject r=identity();r.add("samples",samples);return r;
        }
        if(action.equals("read_blocks")){
            JsonArray positions=q.getAsJsonArray("positions");if(positions==null||positions.size()>16384)throw new IllegalArgumentException("Maximum 16384 positions");JsonObject blocks=new JsonObject();JsonArray unknown=new JsonArray();
            for(JsonElement e:positions){int[] p=gson.fromJson(e,int[].class);if(p.length!=3)throw new IllegalArgumentException("Three coordinates required");bounds(gson.toJsonTree(new int[]{p[0],p[1],p[2],p[0],p[1],p[2]}));String key=p[0]+","+p[1]+","+p[2];if(!world.isChunkGenerated(Math.floorDiv(p[0],16),Math.floorDiv(p[2],16))){unknown.add(key);continue;}blocks.addProperty(key,world.getBlockAt(p[0],p[1],p[2]).getBlockData().getAsString());}JsonObject r=identity();r.add("blocks",blocks);r.add("unknown",unknown);return r;
        }
        if(action.equals("read_block_entities")){
            JsonArray input=q.getAsJsonArray("positions");
            if(input==null||input.size()>128)throw new IllegalArgumentException("Maximum 128 block entities");
            JsonObject entities=new JsonObject();
            for(JsonElement item:input){
                int[] p=gson.fromJson(item,int[].class);
                if(p.length!=3)throw new IllegalArgumentException("Three coordinates required");
                bounds(gson.toJsonTree(new int[]{p[0],p[1],p[2],p[0],p[1],p[2]}));
                if(!world.isChunkGenerated(Math.floorDiv(p[0],16),Math.floorDiv(p[2],16)))continue;
                BlockState state=world.getBlockAt(p[0],p[1],p[2]).getState();
                JsonObject entry=new JsonObject();
                entry.addProperty("state",state.getBlockData().getAsString());
                entry.addProperty("snapshot_available",!(state instanceof TileState)||reversibleEntity(state));
                entry.add("payload",captureEntity(state));
                entities.add(p[0]+","+p[1]+","+p[2],entry);
            }
            JsonObject result=identity();
            result.add("entities",entities);
            return result;
        }
        if(action.equals("normalize")){
            JsonArray input=q.getAsJsonArray("states"),states=new JsonArray();
            if(input==null||input.size()>512)throw new IllegalArgumentException("Maximum 512 unique block states");
            for(JsonElement state:input)states.add(Bukkit.createBlockData(state.getAsString()).getAsString());
            JsonObject r=identity();r.add("states",states);return r;
        }
        if(action.equals("snapshot"))return snapshot(bounds(q.get("bounds")),q.has("generated_only")&&q.get("generated_only").getAsBoolean());
        if(action.equals("save")){world.save();JsonObject r=identity();r.addProperty("saved",true);return r;}
        if(action.equals("stop")){world.save();getServer().getScheduler().runTaskLater(this,()->Bukkit.shutdown(),2L);JsonObject r=identity();r.addProperty("stopping",true);return r;}
        List<Edit> edits=new ArrayList<>();
        if(action.equals("fill")) {
            int[] b=bounds(q.get("bounds")); BlockData data=Bukkit.createBlockData(q.get("state").getAsString());
            for(int y=b[1];y<=b[4];y++)for(int z=b[2];z<=b[5];z++)for(int x=b[0];x<=b[3];x++)edits.add(new Edit(x,y,z,data,null,null,null));
        } else if(action.equals("apply_blocks")) {
            JsonArray input=q.getAsJsonArray("blocks"); if(input==null||input.size()>16384)throw new IllegalArgumentException("Maximum 16384 block edits per call");
            Set<String> seen=new HashSet<>();
            for(JsonElement item:input){JsonObject e=item.getAsJsonObject();int x=e.get("x").getAsInt(),y=e.get("y").getAsInt(),z=e.get("z").getAsInt();
                bounds(gson.toJsonTree(new int[]{x,y,z,x,y,z}));if(!seen.add(x+","+y+","+z))throw new IllegalArgumentException("Duplicate edit coordinate");
                edits.add(new Edit(x,y,z,Bukkit.createBlockData(e.get("state").getAsString()),e.has("before")?Bukkit.createBlockData(e.get("before").getAsString()).getAsString():null,entityField(e,"before"),entityField(e,"after")));}
        } else throw new IllegalArgumentException("Unknown workbench operation");
        return applyEdits(q, edits, id, digest);
    }

    private JsonObject conflict(int x, int y, int z, String actual, String expected) {
        JsonObject result = new JsonObject();
        result.addProperty("coordinate", x+","+y+","+z);
        result.addProperty("actual", actual);
        result.addProperty("expected", expected);
        return result;
    }

    private JsonObject applyEdits(JsonObject q, List<Edit> edits, String id, String digest) throws Exception {
        Path intentFile = intents.resolve(id);
        boolean physics = q.has("physics") && q.get("physics").getAsBoolean();
        boolean journal = q.has("durable") && q.get("durable").getAsBoolean();
        if (journal && physics) throw new IllegalArgumentException("Durable writes require physics=false");
        JsonObject intent;
        if (journal && Files.exists(intentFile)) {
            intent = JsonParser.parseString(Files.readString(intentFile, StandardCharsets.UTF_8)).getAsJsonObject();
            if (!digest.equals(intent.get("request_hash").getAsString())) throw new IllegalArgumentException("Journal request identity changed");
        } else {
            intent = new JsonObject();
            JsonArray planned = new JsonArray(), conflicts = new JsonArray();
            Map<String, BlockState> defaults = new HashMap<>();
            boolean undoable = !physics;
            int already = 0;
            for (Edit edit : edits) {
                if (journal && !world.isChunkGenerated(Math.floorDiv(edit.x,16), Math.floorDiv(edit.z,16))) {
                    conflicts.add(conflict(edit.x,edit.y,edit.z,"unknown_chunk",edit.before));
                    continue;
                }
                Block block = world.getBlockAt(edit.x,edit.y,edit.z);
                String before = block.getBlockData().getAsString(), after = edit.data.getAsString();
                BlockState current = block.getState();
                JsonElement initialEntity = captureEntity(current);
                if (before.equals(after) && (edit.afterEntity == null || sameEntity(initialEntity,edit.afterEntity))) {
                    already++; continue;
                }
                if (edit.before != null && !edit.before.equals(before)) {
                    conflicts.add(conflict(edit.x,edit.y,edit.z,before,edit.before));
                    continue;
                }
                if (edit.beforeEntity != null && !sameEntity(initialEntity,edit.beforeEntity)) {
                    conflicts.add(conflict(edit.x,edit.y,edit.z,"changed_block_entity_data",before));
                    continue;
                }
                BlockState target = defaults.computeIfAbsent(after, ignored -> edit.data.createBlockState());
                boolean unsupported = (current instanceof TileState && !reversibleEntity(current))
                    || (target instanceof TileState && !reversibleEntity(target));
                if (journal && unsupported) {
                    conflicts.add(conflict(edit.x,edit.y,edit.z,"unsupported_block_entity",before));
                    continue;
                }
                if (unsupported) undoable = false;
                JsonElement targetEntity;
                if (edit.afterEntity != null) {
                    BlockState candidate = edit.data.createBlockState();
                    restoreEntity(candidate,edit.afterEntity);
                    targetEntity = captureEntity(candidate);
                    if (!sameEntity(targetEntity,edit.afterEntity)) throw new IllegalArgumentException("Invalid block entity payload");
                } else if (current.getType() == target.getType()) targetEntity = initialEntity;
                else targetEntity = captureEntity(target);
                JsonObject change = new JsonObject();
                change.addProperty("x",edit.x); change.addProperty("y",edit.y); change.addProperty("z",edit.z);
                change.addProperty("before",before); change.addProperty("after",after);
                if (!initialEntity.isJsonNull() || !targetEntity.isJsonNull()) {
                    change.add("before_entity",initialEntity);
                    change.add("after_entity",targetEntity);
                }
                planned.add(change);
            }
            intent.addProperty("request_hash",digest);
            intent.addProperty("already",already);
            intent.addProperty("undoable",undoable);
            intent.add("changes",planned);
            intent.add("conflicts",conflicts);
            if (journal) atomic(intentFile,intent);
        }

        boolean undoable = intent.get("undoable").getAsBoolean();
        JsonArray applied = new JsonArray(), conflicts = intent.getAsJsonArray("conflicts").deepCopy();
        for (JsonElement element : intent.getAsJsonArray("changes")) {
            JsonObject change = element.getAsJsonObject();
            int x=change.get("x").getAsInt(),y=change.get("y").getAsInt(),z=change.get("z").getAsInt();
            Block block=world.getBlockAt(x,y,z);
            String before=change.get("before").getAsString(), after=change.get("after").getAsString();
            String now=block.getBlockData().getAsString();
            JsonElement target = entityField(change,"after");
            if (target != null) {
                BlockState current = block.getState();
                JsonElement actual = captureEntity(current), expected = entityField(change,"before");
                if (!(now.equals(after) && sameEntity(actual,target))) {
                    if (!now.equals(before) || !sameEntity(actual,expected)) {
                        conflicts.add(conflict(x,y,z,"changed_block_entity_data",before));
                        continue;
                    }
                    try {
                        applyEntity(block,current,Bukkit.createBlockData(after),target,physics);
                    } catch (Exception failure) {
                        // Restore the captured pre-state before yielding to other server tasks.
                        try { applyEntity(block,block.getState(),Bukkit.createBlockData(before),expected,physics); }
                        catch (Exception recovery) { failure.addSuppressed(recovery); }
                        throw failure;
                    }
                }
            } else if (now.equals(before)) block.setBlockData(Bukkit.createBlockData(after),physics);
            else if (!now.equals(after)) {
                conflicts.add(conflict(x,y,z,now,before));
                continue;
            }
            if (target==null && block.getState() instanceof TileState) undoable=false;
            JsonObject delta=change.deepCopy();
            delta.addProperty("after", block.getBlockData().getAsString());
            applied.add(delta);
        }
        world.save();
        JsonObject result=identity();
        result.addProperty("changed",applied.size());
        result.addProperty("already",intent.get("already").getAsInt());
        result.add("conflicts",conflicts); result.add("changes",applied);
        result.addProperty("undoable",undoable); result.addProperty("physics",physics);
        return result;
    }

    private void applyEntity(Block block, BlockState current, BlockData next, JsonElement payload, boolean physics) throws Exception {
        if (current.getType()!=next.getMaterial()) PaperBlockEntityCodec.clearBeforeReplacement(current);
        if (!block.getBlockData().equals(next)) block.setBlockData(next,physics);
        if (!payload.isJsonNull()) {
            BlockState placed = block.getState();
            restoreEntity(placed,payload);
            if (!placed.update(false,false) || !sameEntity(captureEntity(block.getState()),payload))
                throw new IllegalStateException("Block entity payload verification failed");
        }
    }

    private Path firstRequest(String pattern) throws Exception {
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(requests,pattern)) {
            for (Path file : stream) {
                if (file.getFileName().toString().matches("[a-f0-9-]{36}\\.json(?:\\.processing)?")) return file;
            }
        }
        return null;
    }

    private void poll() {
        try {
            Path processing=firstRequest("*.json.processing");
            if (processing==null) {
                Path incoming=firstRequest("*.json");
                if (incoming==null) return;
                processing=incoming.resolveSibling(incoming.getFileName()+".processing");
                Files.move(incoming,processing,StandardCopyOption.ATOMIC_MOVE);
            }
            String filename=processing.getFileName().toString(),id=filename.substring(0,filename.length()-".processing".length());
            Path intent=intents.resolve(id), receipt=receipts.resolve(id);
            if (Files.exists(receipt)) {
                Files.deleteIfExists(intent);
                Files.delete(processing);
                return;
            }
            boolean journal=false;
            JsonObject result=new JsonObject();
            try {
                if(Files.size(processing)>4_000_000)throw new IllegalArgumentException("Request too large");
                byte[] bytes=Files.readAllBytes(processing);
                String digest=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
                JsonObject q=JsonParser.parseString(new String(bytes,StandardCharsets.UTF_8)).getAsJsonObject();
                journal=q.has("durable")&&q.get("durable").getAsBoolean();
                result.addProperty("request_hash",digest);
                if(q.has("world_uuid")&&!q.get("world_uuid").getAsString().equals(world.getUID().toString()))throw new IllegalArgumentException("World identity changed");
                if(q.has("minecraft")&&!q.get("minecraft").getAsString().equals(Bukkit.getMinecraftVersion()))
                    throw new IllegalArgumentException("Design Minecraft version differs from the target server");
                result.add("result",execute(q,id,digest));
                result.addProperty("ok",true);
            } catch(Exception error) {
                // A prepared operation may have reached the world before the
                // failure. Retain it and reconcile its actual cells on retry.
                if(journal&&Files.exists(intent))throw error;
                result.addProperty("ok",false);
                result.addProperty("error",error.toString());
            }
            atomic(journal?receipt:responses.resolve(id),result);
            if(journal)Files.deleteIfExists(intent);
            Files.delete(processing);
        } catch(Exception error){getLogger().warning(error.toString());}
    }
}
