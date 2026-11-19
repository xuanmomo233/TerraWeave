import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.lang.reflect.Method;
import org.bukkit.Bukkit;
import org.bukkit.block.Banner;
import org.bukkit.block.Barrel;
import org.bukkit.block.BlockState;
import org.bukkit.block.Chest;
import org.bukkit.block.Container;
import org.bukkit.block.ShulkerBox;

/** Exact NBT adapter for the Paper 1.20.1 runtime. Other runtimes fail closed. */
final class PaperBlockEntityCodec {
    private static final String ID = "paper-1.20.1-snbt";
    private final Method save, parse, remove, getString, snapshot, load, sync;

    static PaperBlockEntityCodec detect() throws ReflectiveOperationException {
        if (!Bukkit.getMinecraftVersion().equals("1.20.1")) return null;
        return new PaperBlockEntityCodec();
    }

    private PaperBlockEntityCodec() throws ReflectiveOperationException {
        String craft = Bukkit.getServer().getClass().getPackageName();
        Class<?> wrapper = Class.forName(craft + ".block.CraftBlockEntityState");
        Class<?> compound = Class.forName("net.minecraft.nbt.NBTTagCompound");
        Class<?> entity = Class.forName("net.minecraft.world.level.block.entity.TileEntity");
        save = wrapper.getMethod("getSnapshotNBT");
        parse = Class.forName("net.minecraft.nbt.MojangsonParser").getMethod("a", String.class);
        remove = compound.getMethod("r", String.class);
        getString = compound.getMethod("l", String.class);
        snapshot = wrapper.getDeclaredMethod("getSnapshot");
        snapshot.setAccessible(true);
        load = entity.getMethod("a", compound);
        sync = wrapper.getDeclaredMethod("load", entity);
        sync.setAccessible(true);
    }

    boolean supports(BlockState state) {
        return state instanceof Chest || state instanceof Barrel || state instanceof ShulkerBox || state instanceof Banner;
    }

    JsonElement capture(BlockState state) throws ReflectiveOperationException {
        if (!supports(state)) return JsonNull.INSTANCE;
        Object tag = save.invoke(state);
        for (String key : new String[]{"x","y","z"}) remove.invoke(tag,key);
        JsonObject payload = new JsonObject();
        payload.addProperty("codec",ID);
        payload.addProperty("snbt",tag.toString());
        return payload;
    }

    private Object parseTag(JsonElement payload) throws ReflectiveOperationException {
        JsonObject value = payload.getAsJsonObject();
        if (!ID.equals(value.get("codec").getAsString())) throw new IllegalArgumentException("Incompatible block entity codec");
        String snbt = value.get("snbt").getAsString();
        if (snbt.length() > 1_000_000) throw new IllegalArgumentException("Block entity payload exceeds size limit");
        return parse.invoke(null,snbt);
    }

    boolean equivalent(JsonElement a, JsonElement b) throws ReflectiveOperationException {
        if (a.equals(b)) return true;
        if (!a.isJsonObject() || !b.isJsonObject()) return false;
        return parseTag(a).equals(parseTag(b));
    }

    void restore(BlockState state, JsonElement payload) throws ReflectiveOperationException {
        if (!supports(state)) throw new IllegalArgumentException("Block entity type does not support this payload");
        Object tag = parseTag(payload);
        String desired = (String)getString.invoke(tag,"id");
        if (!desired.equals(getString.invoke(save.invoke(state),"id")))
            throw new IllegalArgumentException("NBT block entity ID does not match the destination");
        for (String key : new String[]{"x","y","z"}) remove.invoke(tag,key);
        Object data = snapshot.invoke(state);
        load.invoke(data,tag);
        sync.invoke(state,data);
    }

    static void clearBeforeReplacement(BlockState state) {
        if (!(state instanceof Container container)) return;
        if (state instanceof Chest chest) chest.getBlockInventory().clear();
        else container.getInventory().clear();
    }
}
