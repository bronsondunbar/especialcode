import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

export function WorkDetails({
  title,
  action = false,
  children,
}: {
  title: string;
  action?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          setVisited(true);
          setOpen((value) => !value);
        }}
        className={action ? "self-start rounded-lg border border-border px-3 py-3" : "py-3"}
      >
        <Text className="text-sm font-medium">
          {open ? "▾" : "▸"} {title}
        </Text>
      </Pressable>
      {visited && (
        <View style={open ? undefined : { display: "none" }} className="mt-3 gap-4">
          {children}
        </View>
      )}
    </View>
  );
}
