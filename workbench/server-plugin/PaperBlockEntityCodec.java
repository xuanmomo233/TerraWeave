import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import org.bukkit.Bukkit;
import org.bukkit.block.Banner;
import org.bukkit.block.Barrel;
import org.bukkit.block.BlockState;
import org.bukkit.block.Chest;
import org.bukkit.block.Container;
import org.bukkit.block.ShulkerBox;

/** Uses Paper's block-state snapshot and the NBT parser of the running game. */
final class PaperBlockEntityCodec {
    private final String id;
    private final Method save, parse, remove, get;
    private final SnapshotLoader load;

    private interface SnapshotLoader {
        void apply(BlockState state, Object tag) throws ReflectiveOperationException;
    }

    static PaperBlockEntityCodec detect() throws ReflectiveOperationException {
        return new PaperBlockEntityCodec();
    }

    private PaperBlockEntityCodec() throws ReflectiveOperationException {
        String craft = Bukkit.getServer().getClass().getPackageName();
        Class<?> wrapper = Class.forName(craft + ".block.CraftBlockEntityState");
        id = "paper-" + Bukkit.getMinecraftVersion() + "-snbt";
        save = wrapper.getMethod("getSnapshotNBT");
        Class<?> compound = save.getReturnType();
        boolean obfuscated = compound.getSimpleName().equals("NBTTagCompound");
        Class<?> parser = Class.forName(obfuscated ? "net.minecraft.nbt.MojangsonParser" : "net.minecraft.nbt.TagParser");
        remove = compound.getMethod(obfuscated ? "r" : "remove", String.class);
        get = compound.getMethod(obfuscated ? "c" : "get", String.class);
        parse = findParser(parser, compound);
        load = snapshotLoader(wrapper, compound, craft, obfuscated);
    }

    private static Method findParser(Class<?> parser, Class<?> compound) throws ReflectiveOperationException {
        for (String name : new String[]{"parseCompoundFully","parseTag","a"}) {
            try {
                Method found = parser.getMethod(name,String.class);
                if (Modifier.isStatic(found.getModifiers()) && found.getReturnType() == compound) return found;
            } catch (NoSuchMethodException ignored) {}
        }
        throw new NoSuchMethodException("No compound SNBT parser on " + parser.getName());
    }

    private static SnapshotLoader snapshotLoader(Class<?> wrapper, Class<?> compound, String craft, boolean obfuscated)
        throws ReflectiveOperationException {
        try {
            Method loader = wrapper.getMethod("loadData",compound);
            return (state,tag) -> loader.invoke(state,tag);
        } catch (NoSuchMethodException ignored) {}

        Method snapshot = wrapper.getDeclaredMethod("getSnapshot");
        snapshot.setAccessible(true);
        Class<?> entity = snapshot.getReturnType();
        Method sync = wrapper.getDeclaredMethod("load",entity);
        sync.setAccessible(true);
        if (obfuscated) {
            Method loader = entity.getMethod("a",compound);
            return (state,tag) -> {
                Object snapshotEntity = snapshot.invoke(state);
                loader.invoke(snapshotEntity,tag);
                sync.invoke(state,snapshotEntity);
            };
        }
        for (Method method : entity.getMethods()) {
            Class<?>[] params = method.getParameterTypes();
            if (!method.getName().equals("loadWithComponents") || params.length != 2 || params[0] != compound) continue;
            Method registry = Class.forName(craft+".CraftRegistry").getMethod("getMinecraftRegistry");
            return (state,tag) -> {
                Object snapshotEntity = snapshot.invoke(state);
                method.invoke(snapshotEntity,tag,registry.invoke(null));
                sync.invoke(state,snapshotEntity);
            };
        }
        throw new NoSuchMethodException("No block entity snapshot loader for "+Bukkit.getMinecraftVersion());
    }

    boolean supports(BlockState state) {
        return state instanceof Chest || state instanceof Barrel || state instanceof ShulkerBox || state instanceof Banner;
    }

    JsonElement capture(BlockState state) throws ReflectiveOperationException {
        if (!supports(state)) return JsonNull.INSTANCE;
        Object tag = save.invoke(state);
        for (String key : new String[]{"x","y","z"}) remove.invoke(tag,key);
        JsonObject payload = new JsonObject();
        payload.addProperty("codec",id);
        payload.addProperty("snbt",tag.toString());
        return payload;
    }

    private Object parseTag(JsonElement payload) throws ReflectiveOperationException {
        JsonObject value = payload.getAsJsonObject();
        if (!id.equals(value.get("codec").getAsString())) throw new IllegalArgumentException("Incompatible block entity codec");
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
        Object desired = get.invoke(tag,"id");
        if (desired == null || !desired.equals(get.invoke(save.invoke(state),"id")))
            throw new IllegalArgumentException("NBT block entity ID does not match the destination");
        for (String key : new String[]{"x","y","z"}) remove.invoke(tag,key);
        load.apply(state,tag);
    }

    static void clearBeforeReplacement(BlockState state) {
        if (!(state instanceof Container container)) return;
        if (state instanceof Chest chest) chest.getBlockInventory().clear();
        else container.getInventory().clear();
    }
}
