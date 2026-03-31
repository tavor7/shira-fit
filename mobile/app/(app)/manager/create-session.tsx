import { useLocalSearchParams } from "expo-router";
import { CreateSessionForm } from "../../../src/components/CreateSessionForm";

export default function ManagerCreateSessionScreen() {
  const { date } = useLocalSearchParams<{ date?: string | string[] }>();
  const initialDate = Array.isArray(date) ? date[0] : date;
  return <CreateSessionForm initialDate={initialDate} />;
}
