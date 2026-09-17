import { memo, useMemo } from "react";
import { View } from "react-native";
import { Markdown, type CustomRenderers } from "react-native-nitro-markdown";
import { AppText as Text } from "../../components/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useFontFamily } from "../../lib/useFontFamily";

const renderers: CustomRenderers = {
  link: ({ children }) => <Text className="text-primary underline">{children}</Text>,
  image: ({ node }) => <Text>{node.alt || "Image"}</Text>,
};

export const WorkDescriptionPreview = memo(function WorkDescriptionPreview({
  text,
}: {
  text: string;
}) {
  const palette = useUniwindTheme();
  const regular = useFontFamily("regular");
  const heading = useFontFamily("bold");
  const theme = useMemo(
    () => ({
      colors: {
        text: palette["--color-foreground-muted"],
        heading: palette["--color-foreground"],
        code: palette["--color-foreground"],
        codeBackground: palette["--color-md-code-bg"],
        surface: "transparent",
      },
      fontFamilies: { regular, heading },
      fontSizes: { m: 14, h1: 14, h2: 14, h3: 14, h4: 14, h5: 14, h6: 14 },
      spacing: { xs: 0, s: 0, m: 0, l: 0, xl: 0 },
      showCodeLanguage: false,
    }),
    [palette, regular, heading],
  );
  return (
    <View pointerEvents="none" style={{ maxHeight: 60, overflow: "hidden" }}>
      <Markdown
        options={{ gfm: true }}
        highlightCode={false}
        stylingStrategy="minimal"
        theme={theme}
        renderers={renderers}
        styles={{
          text: { fontSize: 14, lineHeight: 20 },
          heading: { fontSize: 14, lineHeight: 20 },
          paragraph: { marginVertical: 0 },
        }}
      >
        {text}
      </Markdown>
    </View>
  );
});
